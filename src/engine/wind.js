// The shared wind field.
//
// Before this existed, every animated thing invented its own motion: the
// foliage had a noise field in its vertex shader, the baubles did not move
// at all, and the bulbs were nailed to coordinates the CPU recomputed.
// The result was a tree whose needles breathed while everything hanging
// off them stayed perfectly still — the single most obvious "this is a
// rendering" tell left in the scene.
//
// So wind becomes one object, updated once per frame on the CPU, read by
// every layer and uploaded as THREE floats. Its value is the same number
// in the foliage shader, the bauble shader and the bulb shader, which is
// what makes an ornament visibly ride the same gust that bends the branch
// it hangs from.
//
// WHY A CPU ENVELOPE RATHER THAN MORE NOISE IN THE SHADER: a gust is a
// low-frequency, scene-wide event. Evaluating it per vertex would cost
// thousands of noise samples per frame to produce one number that is the
// same everywhere. Here it costs four sines, once.

/// A critically-damped follow. Frame-rate independent — the same spring
/// settles over the same wall-clock time at 30 fps and at 120 — which is
/// what stops a gust from arriving as a snap when the fps cap changes.
function approach(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export class Wind {
  constructor({ strength = 1, gustiness = 1, direction = 1 } = {}) {
    this.strength = strength;
    this.gustiness = gustiness;
    this.direction = direction; // -1 .. 1, which way the gusts push
    // `gust` is the smoothed envelope every shader multiplies into its
    // own displacement; `phase` is the slowly advancing clock the noise
    // fields are sampled against, kept separate from the renderer's own
    // `time` so changing wind speed does not jump the animation.
    this.gust = 1;
    this.phase = 0;
    this._raw = 1;
  }

  set(opts = {}) {
    if (opts.strength !== undefined) this.strength = Math.max(0, Number(opts.strength) || 0);
    if (opts.gustiness !== undefined) this.gustiness = Math.max(0, Math.min(2, Number(opts.gustiness) || 0));
    if (opts.direction !== undefined) this.direction = Math.max(-1, Math.min(1, Number(opts.direction) || 0));
  }

  update(dt, time) {
    this.phase += dt * (0.55 + 0.45 * this.strength);

    // Four incommensurate rates: a base breeze, two swells and a fast
    // ripple. No two share a period, so the sequence never settles into
    // something a viewer can anticipate.
    const t = time;
    const swell =
      0.50 * Math.sin(t * 0.083) +
      0.30 * Math.sin(t * 0.191 + 1.7) +
      0.14 * Math.sin(t * 0.431 + 0.3) +
      0.06 * Math.sin(t * 1.117 + 2.4);
    // Raised to a power so the field spends most of its time calm and
    // occasionally spikes: that asymmetry is what reads as "a gust just
    // went through" rather than "everything is oscillating".
    const burst = Math.max(0, Math.sin(t * 0.0731 + 0.9)) ** 8;
    this._raw = 0.55 + 0.45 * swell + burst * 1.35 * this.gustiness;

    // Air has inertia: the canopy cannot change direction instantly, and
    // easing into the target is the difference between a gust and a jolt.
    this.gust = approach(this.gust, Math.max(0.05, this._raw), 2.6, dt);
  }

  /// What a layer uploads. `amount` scales the whole field for one layer
  /// (a sheltered tree can take less wind than an exposed one) without
  /// desynchronising it from the rest of the scene.
  uniforms(amount = 1) {
    return {
      gust: this.gust * this.strength * amount,
      phase: this.phase,
      direction: this.direction,
    };
  }
}

/// The GLSL half. Included by every shader that has something attached to
/// a branch, so a bauble, a bulb and the sprig it hangs from all compute
/// their displacement from the same three lines.
///
/// `anchor`  position in tree space, pixels, y up
/// `amount`  0 at the trunk, ~1 at a branch tip — the lever arm
export const WIND_GLSL = /* glsl */ `
uniform float uWindGust;   // scene-wide gust envelope, from engine/wind.js
uniform float uWindPhase;  // slowly advancing wind clock
uniform float uWindDir;    // -1..1 prevailing direction

vec3 windOffset(vec3 anchor, float amount, float phase) {
  // One noise-ish field sampled at the anchor: neighbours on the same
  // branch are in the same gust, so they travel together instead of
  // jittering independently.
  float field = sin(anchor.x * 0.0031 + uWindPhase * 0.62)
              * cos(anchor.y * 0.0024 - uWindPhase * 0.47 + anchor.z * 0.0018);
  float sway = field * 0.75
             + 0.32 * sin(uWindPhase * 1.10 + phase)
             + 0.16 * sin(uWindPhase * 2.37 + phase * 1.7);
  float amp = amount * uWindGust;
  return vec3(
    (sway + uWindDir * 0.55 * uWindGust) * 9.5 * amp,
    // Pushed sideways, a branch also dips: it pivots, it does not slide.
    -abs(sway) * 3.2 * amp,
    sway * 5.0 * amp
  );
}
`;
