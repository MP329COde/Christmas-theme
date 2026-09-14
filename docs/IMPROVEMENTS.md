# Visual Improvement Roadmap

The Christmas tree is validated and is intentionally out of scope for this roadmap.

## Completed: Aurora palette profiles

- Per-screen palette choices make the aurora fit a scene without altering its animation budget.
- Canvas 2D and WebGL resolve the same palette, so renderer fallback preserves the selected look.
- The selected profile is persisted with the screen composition.

## Next tasks

- Add a weather profile that coordinates snow size, wind, accumulation, and sparkle density.
- Add a sky-density control for stars and shooting-star frequency.
- Add an advanced camera-motion profile with reduced-motion support.
- Add a lighting-rig editor for ambient warmth, bloom, and fireplace contribution.
- Add preview thumbnails for saved scene presets.
- Add a real-GPU performance diagnostic with frame-time history and quality-tier explanation.
- Add visual regression coverage for every sky palette and degraded quality tier.