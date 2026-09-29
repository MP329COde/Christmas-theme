// A scene is an ordered set of independently switchable layers.
//
//   WinterNightScene
//   ├── NorthernLights   z 0.02
//   ├── Stars            z 0.05
//   ├── Snowfall (far)   z 0.25
//   ├── ChristmasTree    z 0.55
//   ├── Fireplace        z 0.60
//   ├── Smoke            z 0.62
//   ├── Embers           z 0.65
//   └── Snowfall (near)  z 0.95
//
// Layers are drawn in ascending z, which is also the order the camera
// parallaxes them by, so "further away" is one number rather than two
// separate decisions that can disagree.

import { LightRig, MAX_LIGHTS } from './lighting.js';

export class Scene {
  constructor(name) {
    this.name = name;
    this.layers = [];
    this.lightRigs = new Map();
  }

  add(layer) {
    this.layers.push(layer);
    this.layers.sort((a, b) => a.z - b.z);
    return layer;
  }

  get(id) {
    return this.layers.find((l) => l.id === id);
  }

  /// Turns one system on or off without touching the others — every layer
  /// owns its own resources and none reads another's state.
  setEnabled(id, enabled) {
    const layer = this.get(id);
    if (layer) layer.enabled = enabled;
  }

  async init(renderer) {
    for (const layer of this.layers) {
      await layer.init(renderer);
    }
  }

  resize(renderer) {
    for (const layer of this.layers) layer.resize?.(renderer);
  }

  update(dt, time, ctx) {
    for (const layer of this.layers) {
      if (layer.enabled && layer.ready) layer.update(dt, time, ctx);
    }
  }

  /// Lights are gathered from every enabled layer BEFORE anything renders,
  /// so a layer drawn first is still lit by a lamp belonging to a layer
  /// drawn last.
  contributeLights(rig, time) {
    const sources = [];
    for (const layer of this.layers) {
      if (!layer.enabled || !layer.ready) continue;
      let source = this.lightRigs.get(layer);
      if (!source) {
        source = new LightRig();
        this.lightRigs.set(layer, source);
      }
      source.clear();
      layer.contributeLights(source, time);
      if (source.count) sources.push({ rig: source, count: 0 });
    }
    // Share the remaining budget instead of letting the first two trees
    // consume it all. Evenly spaced samples still cover each whole canopy.
    let remaining = MAX_LIGHTS - rig.count;
    while (remaining > 0) {
      let assigned = false;
      for (const source of sources) {
        if (source.count >= source.rig.count) continue;
        source.count++;
        assigned = true;
        if (--remaining === 0) break;
      }
      if (!assigned) break;
    }
    for (const source of sources) {
      for (let i = 0; i < source.count; i++) {
        rig.copyLight(source.rig, Math.floor((i + 0.5) * source.rig.count / source.count));
      }
    }
  }

  render(ctx) {
    for (const layer of this.layers) {
      if (layer.enabled && layer.ready) layer.render(ctx);
    }
  }

  dispose() {
    for (const layer of this.layers) layer.dispose();
    this.layers.length = 0;
    this.lightRigs.clear();
  }
}
