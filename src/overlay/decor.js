// Decorative elements drawn onto the same canvas as the snow: a light
// garland along the top edge, a pine tree in each bottom corner, and an
// optional fireplace at bottom-center. Pure canvas drawing, no DOM nodes,
// so it stays cheap to redraw every animation frame alongside the snow.
//
// These are only drawn on the "primary" overlay window (see snow.js) —
// with one overlay window per monitor, drawing full-size decorations on
// every single screen would look cluttered and repetitive rather than
// like a single decorated desktop.

export const DEFAULT_GARLAND_COLORS = ['#ff6b6b', '#ffd166', '#4ecdc4', '#a78bfa'];

/// Draws a wavy garland string across the top of the screen with bulbs
/// that twinkle independently (each on its own phase offset), and a small
/// warm glow behind each lit bulb.
export function drawGarland(ctx, width, time, colors) {
  const y0 = 26;
  const sag = 14;
  const spacing = 46;
  const count = Math.max(2, Math.ceil(width / spacing));

  ctx.save();
  ctx.strokeStyle = 'rgba(20,20,20,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= count; i++) {
    const x = (i / count) * width;
    const y = y0 + Math.sin((i / count) * Math.PI) * sag;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  for (let i = 0; i <= count; i++) {
    const x = (i / count) * width;
    const y = y0 + Math.sin((i / count) * Math.PI) * sag + 6;
    const color = colors[i % colors.length];
    const twinkle = 0.55 + 0.45 * Math.sin(time * 2.2 + i * 1.3);

    ctx.globalAlpha = twinkle;
    ctx.fillStyle = color;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 10);
    glow.addColorStop(0, color);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPineTree(ctx, x, groundY, scale, colors) {
  const trunkW = 14 * scale;
  const trunkH = 22 * scale;
  const tierH = 46 * scale;
  const tiers = 3;
  const baseWidth = 90 * scale;

  ctx.save();

  // Trunk
  ctx.fillStyle = '#5b3a29';
  ctx.fillRect(x - trunkW / 2, groundY - trunkH, trunkW, trunkH);

  // Foliage tiers (stacked triangles, widest at bottom)
  ctx.fillStyle = colors.secondary;
  for (let t = 0; t < tiers; t++) {
    const tierTop = groundY - trunkH - tierH * (t + 1) * 0.72;
    const tierBottom = groundY - trunkH - tierH * t * 0.72 + 6 * scale;
    const width = baseWidth * (1 - t * 0.24);
    ctx.beginPath();
    ctx.moveTo(x, tierTop);
    ctx.lineTo(x - width / 2, tierBottom);
    ctx.lineTo(x + width / 2, tierBottom);
    ctx.closePath();
    ctx.fill();
  }

  const topY = groundY - trunkH - tierH * tiers * 0.72;

  // Ornaments: a few small colored dots scattered across the foliage
  const ornamentColors = [colors.primary, colors.accent, '#ffffff'];
  let seed = Math.round(x); // deterministic per-tree so ornaments don't jitter every frame
  function rand() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  }
  for (let i = 0; i < 10; i++) {
    const t = rand();
    const tierIdx = Math.floor(t * tiers);
    const tierTop = groundY - trunkH - tierH * (tierIdx + 1) * 0.72;
    const tierBottom = groundY - trunkH - tierH * tierIdx * 0.72 + 6 * scale;
    const width = baseWidth * (1 - tierIdx * 0.24);
    const oy = tierTop + (tierBottom - tierTop) * (0.3 + rand() * 0.6);
    const spread = (width / 2) * (0.15 + (1 - (oy - tierTop) / (tierBottom - tierTop)) * 0.5);
    const ox = x + (rand() * 2 - 1) * spread;
    ctx.fillStyle = ornamentColors[i % ornamentColors.length];
    ctx.beginPath();
    ctx.arc(ox, oy, 3 * scale, 0, Math.PI * 2);
    ctx.fill();
  }

  // Star topper
  ctx.fillStyle = colors.accent;
  drawStar(ctx, x, topY - 6 * scale, 5, 9 * scale, 4 * scale);

  ctx.restore();
}

function drawStar(ctx, cx, cy, points, outerR, innerR) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = (Math.PI / points) * i - Math.PI / 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/// Draws one pine tree in each bottom corner.
export function drawTrees(ctx, width, height, colors) {
  const groundY = height - 4;
  const scale = Math.max(0.7, Math.min(1.6, height / 900));
  drawPineTree(ctx, 90 * scale + 20, groundY, scale, colors);
  drawPineTree(ctx, width - (90 * scale + 20), groundY, scale, colors);
}

/// Draws a small animated fireplace at bottom-center: a brick surround,
/// a dark hearth opening, and a flickering flame.
export function drawFireplace(ctx, width, height, time) {
  const w = 140;
  const h = 120;
  const x = width / 2 - w / 2;
  const y = height - h;

  ctx.save();

  // Brick surround
  ctx.fillStyle = '#7a3b2e';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  for (let row = 0; row < h / 14; row++) {
    const ry = y + row * 14;
    const offset = row % 2 === 0 ? 0 : 15;
    for (let bx = x - 15; bx < x + w + 15; bx += 30) {
      ctx.strokeRect(bx + offset, ry, 30, 14);
    }
  }

  // Mantel
  ctx.fillStyle = '#4a2a20';
  ctx.fillRect(x - 10, y - 10, w + 20, 12);

  // Hearth opening
  const openingW = w * 0.66;
  const openingH = h * 0.62;
  const ox = x + (w - openingW) / 2;
  const oy = y + h - openingH;
  ctx.fillStyle = '#1a1210';
  ctx.beginPath();
  ctx.moveTo(ox, oy + openingH);
  ctx.lineTo(ox, oy + openingH * 0.35);
  ctx.quadraticCurveTo(ox, oy, ox + openingW / 2, oy);
  ctx.quadraticCurveTo(ox + openingW, oy, ox + openingW, oy + openingH * 0.35);
  ctx.lineTo(ox + openingW, oy + openingH);
  ctx.closePath();
  ctx.fill();

  // Flame: a few overlapping flickering teardrop shapes
  const flameBaseX = ox + openingW / 2;
  const flameBaseY = oy + openingH - 6;
  const flicker = (i) => 0.85 + 0.15 * Math.sin(time * 9 + i * 2.1) + 0.08 * Math.sin(time * 23 + i);

  const flameLayers = [
    { color: '#ffb347', height: 46, width: 26 },
    { color: '#ff7043', height: 34, width: 20 },
    { color: '#ffe97f', height: 20, width: 12 },
  ];
  flameLayers.forEach((layer, i) => {
    const f = flicker(i);
    ctx.fillStyle = layer.color;
    ctx.beginPath();
    ctx.moveTo(flameBaseX, flameBaseY);
    ctx.quadraticCurveTo(
      flameBaseX - layer.width * f, flameBaseY - layer.height * 0.5 * f,
      flameBaseX, flameBaseY - layer.height * f
    );
    ctx.quadraticCurveTo(
      flameBaseX + layer.width * f, flameBaseY - layer.height * 0.5 * f,
      flameBaseX, flameBaseY
    );
    ctx.fill();
  });

  // Warm glow onto the hearth floor
  const glow = ctx.createRadialGradient(flameBaseX, flameBaseY, 0, flameBaseX, flameBaseY, 70);
  glow.addColorStop(0, 'rgba(255,150,60,0.35)');
  glow.addColorStop(1, 'rgba(255,150,60,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(x - 40, y - 40, w + 80, h + 40);

  ctx.restore();
}
