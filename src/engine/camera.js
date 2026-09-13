// A slow, never-repeating camera drift, and the parallax it produces.
//
// The old renderer had no camera at all: every element sat at z = 0 and
// the frame was geometrically identical from one second to the next. A
// scene that never moves as a whole reads as a picture, however much its
// individual parts animate. A few pixels of continuous drift is enough to
// read as "a space you are looking into" — this is the same trick a slow
// push-in gives a static film shot.
//
// The motion is the sum of sines at incommensurable frequencies, so it has
// no period a viewer can learn, and it is bounded, so it never wanders off.

export class Camera {
  constructor({ amplitude = 26, breathe = 0.012 } = {}) {
    this.amplitude = amplitude; // pixels of travel at z = 1
    this.breathe = breathe; // fractional zoom
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
  }

  update(time) {
    // Ratios chosen irrational-ish (no small common multiple) so the two
    // axes never come back into step.
    this.x = this.amplitude * (
      0.62 * Math.sin(time * 0.043) +
      0.38 * Math.sin(time * 0.0187 + 2.1)
    );
    this.y = this.amplitude * 0.45 * (
      0.7 * Math.sin(time * 0.031 + 1.3) +
      0.3 * Math.sin(time * 0.0113 + 0.4)
    );
    this.zoom = 1 + this.breathe * Math.sin(time * 0.021 + 0.9);
  }

  /// Screen offset for a layer at depth `z`, where z = 0 is the far
  /// background and z = 1 is right in front of the viewer. Nearer layers
  /// travel further for the same camera move, which is exactly what
  /// parallax is, and what gives a flat composition a sense of depth.
  offsetFor(z) {
    return { x: -this.x * z, y: -this.y * z };
  }
}
