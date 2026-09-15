// Shared frame-time budget + automatic quality degrade.
//
// This is the one non-negotiable system in the whole app: it is a
// permanent background wallpaper, so it must never be the reason a fan
// spins up. Nothing here allocates in the sampling path (a Float32Array
// ring buffer, plain fields, no closures created per frame), because a
// perf guard that itself causes GC churn defeats its own purpose.
//
// It does not — cannot — read real OS-level CPU%: no such API is exposed
// to page JavaScript, in Tauri's webview or anywhere else. What IS
// measurable is exactly what a caller already times around its own
// render() call: wall-clock milliseconds spent doing our own drawing
// work. That is used as the proxy, against a target derived from the
// user's chosen frame-rate cap (see snow.js / renderer.js), which is a
// reasonable stand-in for "the fraction of the frame budget we are
// allowed to spend" — documented here explicitly so it is never mistaken
// for an actual CPU percentage.

/// Fixed-size ring buffer average. ~180 samples covers ~3s at 60fps or
/// ~6s at 30fps, which is enough to ride out one slow frame (a GC pause,
/// the OS scheduling us out for a moment) without reacting to it, while
/// still noticing sustained overage within a few seconds.
export class FrameMonitor {
  constructor(size = 180) {
    this.buf = new Float32Array(size);
    this.size = size;
    this.idx = 0;
    this.count = 0;
    this.sum = 0;
  }

  push(ms) {
    const i = this.idx;
    this.sum += ms - this.buf[i];
    this.buf[i] = ms;
    this.idx = (i + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  get average() {
    return this.count ? this.sum / this.count : 0;
  }

  /// The samples in the order they were pushed (oldest first), for a
  /// caller that wants to draw a history rather than just read the
  /// rolling average — a settings-window diagnostic, say. Only called a
  /// couple of times a second from outside the render loop, so the
  /// allocation here is not the one this module's header warns against.
  history() {
    const out = new Array(this.count);
    const start = this.count < this.size ? 0 : this.idx;
    for (let i = 0; i < this.count; i++) {
      out[i] = this.buf[(start + i) % this.size];
    }
    return out;
  }

  reset() {
    this.buf.fill(0);
    this.idx = 0;
    this.count = 0;
    this.sum = 0;
  }
}

/// Tracks a rolling frame-time average against a target and steps through
/// a caller-supplied table of quality tiers (index 0 = full fidelity)
/// when the average is sustained over/under budget — never on a single
/// spike, and with separate, WIDER margins for stepping down than for
/// recovering back up (hysteresis), so the app doesn't visibly flicker
/// between two quality levels sitting right at the edge of the budget.
export class QualityGovernor {
  constructor({
    tiers,
    targetFrameMs = 16.7,
    downFactor = 1.35,
    upFactor = 0.7,
    sustainDownMs = 3000,
    sustainUpMs = 6000,
    // Every overlay window on a multi-monitor desktop shares ONE machine:
    // if one monitor's window is struggling (a 4K panel doing heavier
    // work than a laptop's built-in screen, say), the whole machine is
    // under load, not just that window. A BroadcastChannel lets windows
    // of the same app tell each other their tier, and every window runs
    // at the WORST tier seen recently rather than each deciding in
    // isolation — which is what actually keeps a multi-screen setup from
    // "saturating" even though the slow screen is the only one measuring
    // it. Pass null to opt out (used by tests running in isolation).
    channel = null,
    debug = false,
    onChange = null,
  } = {}) {
    if (!Array.isArray(tiers) || tiers.length === 0) {
      throw new Error('QualityGovernor requires a non-empty tiers array');
    }
    this.tiers = tiers;
    this.targetFrameMs = targetFrameMs;
    this.downFactor = downFactor;
    this.upFactor = upFactor;
    this.sustainDownMs = sustainDownMs;
    this.sustainUpMs = sustainUpMs;
    this.debug = debug;
    this.onChange = onChange;

    this.monitor = new FrameMonitor();
    this.localTier = 0;
    this.effectiveTier = 0;
    this.overSince = 0;
    this.underSince = 0;

    this.peerTier = 0;
    this.peerAt = 0;
    this.peerTimeoutMs = 5000;

    this.bc = null;
    if (channel && typeof BroadcastChannel !== 'undefined') {
      try {
        this.bc = new BroadcastChannel(channel);
        this.bc.onmessage = (e) => {
          const tier = e.data?.tier;
          if (typeof tier === 'number' && tier >= 0 && tier < this.tiers.length) {
            this.peerTier = tier;
            this.peerAt = performance.now();
          }
        };
      } catch {
        this.bc = null; // BroadcastChannel unsupported/blocked: stay local-only.
      }
    }
  }

  /// Feeds one frame's measured cost, in milliseconds. Returns the tier
  /// index (into the `tiers` array passed to the constructor) that should
  /// be in effect THIS frame — the caller applies whatever that tier's
  /// fields mean to it (ray counts, render scale, flake density, ...).
  sample(ms, now = performance.now()) {
    this.monitor.push(ms);
    const avg = this.monitor.average;
    const target = this.targetFrameMs;

    if (avg > target * this.downFactor) {
      if (!this.overSince) this.overSince = now;
      this.underSince = 0;
      if (now - this.overSince >= this.sustainDownMs && this.localTier < this.tiers.length - 1) {
        this._setLocalTier(this.localTier + 1, now);
        this.overSince = now; // re-arm — still over budget, keep stepping down
      }
    } else if (avg < target * this.upFactor) {
      if (!this.underSince) this.underSince = now;
      this.overSince = 0;
      if (now - this.underSince >= this.sustainUpMs && this.localTier > 0) {
        this._setLocalTier(this.localTier - 1, now);
        this.underSince = now;
      }
    } else {
      // Comfortably inside the hysteresis band: neither timer should be
      // running, or a brief dip below the "over" threshold would count
      // toward recovery it hasn't earned.
      this.overSince = 0;
      this.underSince = 0;
    }

    const peerFresh = now - this.peerAt < this.peerTimeoutMs;
    const effective = Math.max(this.localTier, peerFresh ? this.peerTier : 0);
    if (effective !== this.effectiveTier) {
      this.effectiveTier = effective;
      if (this.debug) {
        // eslint-disable-next-line no-console -- deliberately debug-only
        console.debug(
          `[perf] quality tier -> ${effective} (${this.tiers[effective]?.label ?? effective}); `
          + `avg ${avg.toFixed(2)}ms vs target ${target.toFixed(1)}ms; `
          + `local=${this.localTier} peer=${peerFresh ? this.peerTier : '-'}`
        );
      }
      this.onChange?.(this.tiers[effective], effective);
    }
    return this.effectiveTier;
  }

  _setLocalTier(tier, now) {
    this.localTier = tier;
    this.bc?.postMessage({ tier, at: now });
  }

  get tier() {
    return this.tiers[this.effectiveTier];
  }

  get tierIndex() {
    return this.effectiveTier;
  }

  setTargetFrameMs(ms) {
    this.targetFrameMs = ms;
  }

  dispose() {
    try { this.bc?.close(); } catch { /* already closed */ }
  }
}

/// Debug logging must never happen in production. On by `?debug=1` in the
/// URL or `localStorage['christmas-debug'] === '1'` — the same knob a
/// developer already reaches for — never by default.
export function debugEnabled() {
  try {
    if (new URLSearchParams(location.search).get('debug') === '1') return true;
  } catch { /* no location (non-browser test context) */ }
  try {
    return localStorage.getItem('christmas-debug') === '1';
  } catch {
    return false;
  }
}
