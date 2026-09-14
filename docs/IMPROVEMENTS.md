# Visual Improvement Roadmap

The Christmas tree is validated and is intentionally out of scope for this roadmap.

## Completed: Aurora palette profiles

- Per-screen palette choices make the aurora fit a scene without altering its animation budget.
- Canvas 2D and WebGL resolve the same palette, so renderer fallback preserves the selected look.
- The selected profile is persisted with the screen composition.

## Completed: Weather profiles

- Per-screen weather profiles coordinate snow size, wind, accumulation depth, and settled-snow sparkle density.
- Profiles modulate the existing global snow controls, preserving a user's preferred baseline while allowing each display its own weather.
- The selected profile is persisted with the screen composition and saved presets.

## Completed: Sky density and shooting-star frequency

- Per-screen controls tune the density of the continuous star field and the cadence of shooting stars.
- A zero shooting-star frequency disables comets without disabling the stars themselves.
- Both controls are persisted with the screen composition and preserved by saved presets.

## Completed: Camera-motion profiles

- Per-screen profiles range from locked-off framing to immersive drift while preserving existing camera-motion values.
- The default system profile honors the operating system's reduced-motion preference.

## Next tasks

- Add a lighting-rig editor for ambient warmth, bloom, and fireplace contribution.
- Add preview thumbnails for saved scene presets.
- Add a real-GPU performance diagnostic with frame-time history and quality-tier explanation.
- Add visual regression coverage for every sky palette and degraded quality tier.
