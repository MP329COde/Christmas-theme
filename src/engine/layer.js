// The contract every visual system implements.
//
// One system per file — ChristmasTree, Snowfall, Fireplace, Smoke,
// Embers... — each independently switchable and each composable into a
// scene with the others. Nothing in a layer knows about any other layer;
// the only things they share are the light rig (they contribute to it and
// read from it) and the camera.

export class Layer {
  /// `z` is the parallax depth: 0 = far background, 1 = right in front of
  /// the viewer. It decides both how much the layer moves with the camera
  /// and the order it is drawn in.
  constructor(id, { z = 0.5, enabled = true } = {}) {
    this.id = id;
    this.z = z;
    this.enabled = enabled;
    this.ready = false;
  }

  /// Build GPU resources. Called once, with the renderer available for
  /// programs, textures and targets. May be async.
  async init(/* renderer */) {
    this.ready = true;
  }

  /// Advance simulation. `dt` is seconds since the previous update,
  /// already clamped by the renderer so a stall (tab hidden, display
  /// asleep) cannot teleport a particle system.
  update(/* dt, time, ctx */) {}

  /// Declare this layer's lights into the shared rig, before anything is
  /// rendered. Called every frame so a flickering bulb affects the whole
  /// scene, not only its own layer.
  contributeLights(/* rig, time */) {}

  /// Draw. The renderer has already bound the scene target and set the
  /// viewport; the layer sets its own program, blend mode and uniforms.
  render(/* ctx */) {}

  /// Release GPU resources.
  dispose() {}
}
