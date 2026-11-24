// Fonds « scènes » : intérieurs chaleureux et ville nocturne. Chaque scène
// est cuite UNE fois en calques (meuble, mur, vue extérieure) ; l'animation
// ne fait que des copies de sprites (neige derrière la vitre, lueurs qui
// vacillent, guirlandes qui scintillent, phares). Coût par image fixe.

const rgba = (hex, alpha) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',')},${alpha})`;
const mix = (a, b, t) => `#${[1, 3, 5].map((i) => Math.round(
  parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t,
).toString(16).padStart(2, '0')).join('')}`;

function random(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function layer(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w)); canvas.height = Math.max(1, Math.ceil(h));
  draw(canvas.getContext('2d'));
  return canvas;
}

function glowSprite(color, size = 128, strength = 0.5) {
  return layer(size, size, (c) => {
    const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, rgba(color, strength)); g.addColorStop(0.4, rgba(color, strength * 0.32));
    g.addColorStop(1, rgba(color, 0));
    c.fillStyle = g; c.fillRect(0, 0, size, size);
  });
}

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath(); c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

function pineSilhouette(c, x, base, height, color) {
  c.fillStyle = color;
  for (let k = 0; k < 5; k++) {
    const y = base - height + k * height * 0.18, half = height * (0.08 + k * 0.05);
    c.beginPath(); c.moveTo(x, y - height * 0.06); c.lineTo(x + half, y + height * 0.2); c.lineTo(x - half, y + height * 0.2); c.fill();
  }
}

// Nuit d'hiver vue à travers une ouverture (vitre) : ciel, lune, collines, sapins.
function nightView(w, h, colors, moonX = 0.7) {
  return layer(w, h, (c) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, mix(colors.sky, '#000000', 0.25)); g.addColorStop(0.75, mix(colors.sky, colors.horizon, 0.5));
    g.addColorStop(1, mix(colors.horizon, colors.snow, 0.3));
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    const rng = random(11);
    for (let i = 0; i < 70; i++) {
      c.fillStyle = rgba(colors.snow, 0.25 + rng() * 0.5);
      c.beginPath(); c.arc(rng() * w, rng() * h * 0.55, 0.4 + rng() * 0.9, 0, 7); c.fill();
    }
    const mg = c.createRadialGradient(w * moonX, h * 0.22, 0, w * moonX, h * 0.22, h * 0.4);
    mg.addColorStop(0, rgba(colors.snow, 0.4)); mg.addColorStop(1, rgba(colors.snow, 0));
    c.fillStyle = mg; c.fillRect(0, 0, w, h);
    c.fillStyle = '#f3f5e9'; c.beginPath(); c.arc(w * moonX, h * 0.22, h * 0.055, 0, 7); c.fill();
    c.fillStyle = mix(colors.sky, colors.horizon, 0.42);
    c.beginPath(); c.moveTo(0, h);
    for (let x = 0; x <= w + 10; x += 10) c.lineTo(x, h * 0.66 + Math.sin(x / w * 5) * h * 0.04 + Math.sin(x / w * 13) * h * 0.012);
    c.lineTo(w, h); c.fill();
    for (let i = 0; i < 26; i++) {
      pineSilhouette(c, rng() * w, h * (0.7 + rng() * 0.08), h * (0.12 + rng() * 0.16), mix(colors.sky, '#000000', 0.45 + rng() * 0.2));
    }
    c.fillStyle = mix(colors.snow, colors.horizon, 0.35);
    c.beginPath(); c.moveTo(0, h);
    for (let x = 0; x <= w + 10; x += 10) c.lineTo(x, h * 0.86 + Math.sin(x / w * 4 + 1) * h * 0.03);
    c.lineTo(w, h); c.fill();
  });
}

function drawFlakes(c, x, y, w, h, t, count, color, wind = 1) {
  c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
  c.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const depth = 0.4 + (i * 0.618 % 1) * 0.9;
    const fx = x + ((i * 173.7 + t * (6 + 9 * depth) * wind + Math.sin(t * 0.6 + i) * 8) % (w + 20) + w + 20) % (w + 20) - 10;
    const fy = y + (i * 91.3 + t * (14 + 24 * depth)) % (h + 10) - 5;
    c.globalAlpha = 0.35 + depth * 0.45;
    c.beginPath(); c.arc(fx, fy, 0.6 + depth * 1.5, 0, 7); c.fill();
  }
  c.restore();
}

function woodGrain(c, x, y, w, h, base, rng, lines = 8) {
  const g = c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, mix(base, '#ffffff', 0.08)); g.addColorStop(0.5, base); g.addColorStop(1, mix(base, '#000000', 0.3));
  c.fillStyle = g; c.fillRect(x, y, w, h);
  c.lineWidth = 0.8;
  for (let i = 0; i < lines; i++) {
    c.strokeStyle = rgba('#000000', 0.06 + rng() * 0.1);
    const yy = y + rng() * h; c.beginPath(); c.moveTo(x, yy);
    c.bezierCurveTo(x + w * 0.3, yy + (rng() - 0.5) * 5, x + w * 0.6, yy + (rng() - 0.5) * 5, x + w, yy + (rng() - 0.5) * 3); c.stroke();
  }
}

// --------------------------------------------------------------------------
// Salon
// --------------------------------------------------------------------------
function bakeLivingRoom(w, h, colors) {
  const win = { x: w * 0.31, y: h * 0.1, w: w * 0.38, h: h * 0.5 };
  const floorY = h * 0.8;
  const view = nightView(win.w, win.h, colors);
  const room = layer(w, h, (c) => {
    const rng = random(31);
    // Mur : dégradé chaud, lambris en bas.
    const wall = c.createLinearGradient(0, 0, 0, floorY);
    wall.addColorStop(0, '#2b1f26'); wall.addColorStop(1, '#4a3329');
    c.fillStyle = wall; c.fillRect(0, 0, w, floorY);
    c.strokeStyle = rgba('#ffffff', 0.025); c.lineWidth = 1;
    for (let x = 0; x < w; x += w / 36) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, floorY * 0.7); c.stroke(); }
    const rail = h * 0.6;
    c.fillStyle = '#e9dfcf'; c.fillRect(0, rail, w, h * 0.012);
    const panel = c.createLinearGradient(0, rail, 0, floorY);
    panel.addColorStop(0, '#d8cdbb'); panel.addColorStop(1, '#a59a88');
    c.fillStyle = panel; c.fillRect(0, rail + h * 0.012, w, floorY - rail);
    c.strokeStyle = rgba('#5a4d3f', 0.35); c.lineWidth = 1.2;
    for (let x = w * 0.02; x < w; x += w * 0.1) roundRect(c, x, rail + h * 0.03, w * 0.08, floorY - rail - h * 0.05, 3), c.stroke();
    c.fillStyle = '#efe6d6'; c.fillRect(0, floorY - h * 0.015, w, h * 0.016);
    // Parquet en perspective.
    const wood = c.createLinearGradient(0, floorY, 0, h);
    wood.addColorStop(0, '#6a4630'); wood.addColorStop(1, '#3a2418');
    c.fillStyle = wood; c.fillRect(0, floorY, w, h - floorY);
    c.strokeStyle = rgba('#000000', 0.28); c.lineWidth = 1;
    for (let i = -12; i <= 12; i++) {
      c.beginPath(); c.moveTo(w / 2 + i * w * 0.02, floorY); c.lineTo(w / 2 + i * w * 0.11, h); c.stroke();
    }
    for (let r = 1; r < 5; r++) {
      const y = floorY + (h - floorY) * (r / 5) ** 1.5;
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
    }
    // Tapis.
    c.save(); c.translate(w / 2, h * 0.92); c.scale(1, 0.16);
    const rug = c.createRadialGradient(0, 0, 0, 0, 0, w * 0.3);
    rug.addColorStop(0, '#9d4544'); rug.addColorStop(0.7, '#6d222c'); rug.addColorStop(1, '#3c131c');
    c.fillStyle = rug; c.beginPath(); c.arc(0, 0, w * 0.3, 0, 7); c.fill();
    c.strokeStyle = rgba('#f0d9a8', 0.5); c.lineWidth = Math.max(2, w * 0.003);
    for (const radius of [0.247, 0.26]) { c.beginPath(); c.arc(0, 0, w * radius, 0, 7); c.stroke(); }
    for (let i = 0; i < 48; i++) {
      const a = i * Math.PI * 2 / 48, r = w * 0.225;
      c.beginPath(); c.arc(Math.cos(a) * r, Math.sin(a) * r, w * 0.002, 0, 7); c.stroke();
    }
    c.restore();
    // Fenêtre : on découpe la vitre puis on dessine cadre et croisillons.
    c.fillStyle = '#efe8dc'; c.fillRect(win.x - 14, win.y - 14, win.w + 28, win.h + 28);
    c.globalCompositeOperation = 'destination-out'; c.fillRect(win.x, win.y, win.w, win.h);
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = '#efe8dc';
    c.fillRect(win.x + win.w / 2 - 4, win.y, 8, win.h);
    c.fillRect(win.x, win.y + win.h * 0.4, win.w, 7);
    c.fillStyle = '#d8cfbf'; c.fillRect(win.x - 24, win.y + win.h + 10, win.w + 48, 14);
    const sheen = c.createLinearGradient(win.x, win.y, win.x + win.w, win.y + win.h);
    sheen.addColorStop(0, 'rgba(255,255,255,0.14)'); sheen.addColorStop(0.3, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.7, 'rgba(255,255,255,0)'); sheen.addColorStop(1, 'rgba(255,255,255,0.08)');
    c.fillStyle = sheen; c.fillRect(win.x, win.y, win.w, win.h);
    // Rideaux de velours.
    for (const side of [-1, 1]) {
      const cw = w * 0.1, cx = side < 0 ? win.x - cw * 0.85 : win.x + win.w - cw * 0.15;
      const cg = c.createLinearGradient(cx, 0, cx + cw, 0);
      cg.addColorStop(0, '#5a141c'); cg.addColorStop(0.5, '#a02a36'); cg.addColorStop(1, '#5a141c');
      c.fillStyle = cg; c.beginPath(); c.moveTo(cx, win.y - 30);
      c.lineTo(cx + cw, win.y - 30); c.quadraticCurveTo(cx + cw * (side < 0 ? 0.7 : 1.1), win.y + win.h * 0.7, cx + cw * (side < 0 ? 1 : 0.95), floorY);
      c.lineTo(cx, floorY); c.quadraticCurveTo(cx + cw * (side < 0 ? 0 : 0.3), win.y + win.h * 0.7, cx, win.y - 30); c.fill();
      c.strokeStyle = rgba('#1a0408', 0.4); c.lineWidth = 1.5;
      for (let f = 1; f < 6; f++) { c.beginPath(); c.moveTo(cx + cw * f / 6, win.y - 28); c.lineTo(cx + cw * f / 6 + side * 2, floorY); c.stroke(); }
      c.fillStyle = '#d8b25c'; c.beginPath(); c.arc(side < 0 ? cx + cw * 0.95 : cx + cw * 0.05, win.y + win.h * 0.62, 7, 0, 7); c.fill();
    }
    c.fillStyle = '#c59f4e'; c.fillRect(win.x - w * 0.12, win.y - 40, win.w + w * 0.24, 9);
    // Canapé.
    const sx = w * 0.33, sw = w * 0.34, sy = h * 0.66;
    c.fillStyle = rgba('#000000', 0.3); c.beginPath(); c.ellipse(w / 2, floorY + h * 0.02, sw * 0.58, h * 0.02, 0, 0, 7); c.fill();
    const fabric = c.createLinearGradient(0, sy, 0, sy + h * 0.15);
    fabric.addColorStop(0, '#2f5a5e'); fabric.addColorStop(1, '#1e3c40');
    c.fillStyle = fabric; roundRect(c, sx, sy, sw, h * 0.1, 14); c.fill();
    roundRect(c, sx - w * 0.025, sy + h * 0.04, w * 0.04, h * 0.12, 10); c.fill();
    roundRect(c, sx + sw - w * 0.015, sy + h * 0.04, w * 0.04, h * 0.12, 10); c.fill();
    c.fillStyle = mix('#2f5a5e', '#ffffff', 0.08); roundRect(c, sx + w * 0.012, sy + h * 0.085, sw - w * 0.024, h * 0.07, 10); c.fill();
    c.strokeStyle = rgba('#000000', 0.25); c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(sx + sw / 2, sy + h * 0.09); c.lineTo(sx + sw / 2, sy + h * 0.155); c.stroke();
    c.save();
    roundRect(c, sx, sy, sw, h * 0.1, 14); c.clip();
    for (let i = 0; i < 500; i++) {
      c.fillStyle = i % 2 ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.07)';
      c.fillRect(sx + rng() * sw, sy + rng() * h * 0.1, 1 + rng() * 2, 0.7);
    }
    c.restore();
    c.strokeStyle = 'rgba(220,242,230,0.16)';
    c.beginPath(); c.moveTo(sx + sw * 0.05, sy + h * 0.015);
    c.quadraticCurveTo(sx + sw * 0.5, sy - h * 0.004, sx + sw * 0.95, sy + h * 0.015); c.stroke();
    // Coussins et plaid.
    const cushion = (x, y, s, col, rot) => {
      c.save(); c.translate(x, y); c.rotate(rot); c.fillStyle = col; roundRect(c, -s / 2, -s / 2, s, s * 0.9, 8); c.fill();
      c.strokeStyle = rgba('#ffffff', 0.25); c.lineWidth = 1.2;
      for (let i = -2; i <= 2; i++) { c.beginPath(); c.moveTo(-s / 2 + 4, i * s * 0.15); c.lineTo(s / 2 - 4, i * s * 0.15); c.stroke(); }
      c.restore();
    };
    cushion(sx + sw * 0.18, sy + h * 0.095, w * 0.05, '#b5303c', -0.12);
    cushion(sx + sw * 0.82, sy + h * 0.095, w * 0.05, '#d9a441', 0.1);
    c.fillStyle = '#9b2a36'; roundRect(c, sx + sw * 0.55, sy + h * 0.082, sw * 0.3, h * 0.07, 6); c.fill();
    c.strokeStyle = rgba('#e8d9bd', 0.55);
    for (let i = 0; i < 4; i++) { c.beginPath(); c.moveTo(sx + sw * (0.58 + i * 0.07), sy + h * 0.085); c.lineTo(sx + sw * (0.58 + i * 0.07), sy + h * 0.15); c.stroke(); }
    // Lampadaire.
    const lx = w * 0.2;
    c.fillStyle = '#1a1512'; c.fillRect(lx - 2, h * 0.38, 4, floorY - h * 0.38 + h * 0.03);
    c.beginPath(); c.ellipse(lx, floorY + h * 0.035, 22, 5, 0, 0, 7); c.fill();
    const shade = c.createLinearGradient(lx - 34, 0, lx + 34, 0);
    shade.addColorStop(0, '#d9b980'); shade.addColorStop(0.5, '#fbe6b4'); shade.addColorStop(1, '#c9a468');
    c.fillStyle = shade; c.beginPath(); c.moveTo(lx - 20, h * 0.3); c.lineTo(lx + 20, h * 0.3); c.lineTo(lx + 34, h * 0.39); c.lineTo(lx - 34, h * 0.39); c.fill();
    // Étagère + cadres + bougies (côté droit).
    const shx = w * 0.76;
    woodGrain(c, shx, h * 0.34, w * 0.2, 10, '#6b4a30', rng, 2);
    woodGrain(c, shx, h * 0.5, w * 0.2, 10, '#6b4a30', rng, 2);
    const books = ['#8c2f39', '#2f5a5e', '#d9a441', '#3b3f6b', '#7a5a3a', '#a3452f'];
    let bx = shx + 8;
    for (let i = 0; i < 9; i++) {
      const bw2 = 9 + rng() * 9, bh = h * (0.05 + rng() * 0.05);
      c.fillStyle = books[i % books.length]; c.fillRect(bx, h * 0.5 - bh, bw2, bh); bx += bw2 + 2;
      if (bx > shx + w * 0.13) break;
    }
    for (const [fx, fy, fw, fh] of [[shx + w * 0.02, h * 0.2, w * 0.05, h * 0.09], [shx + w * 0.09, h * 0.18, w * 0.07, h * 0.11], [w * 0.05, h * 0.2, w * 0.07, h * 0.1]]) {
      c.fillStyle = '#b08d57'; c.fillRect(fx - 6, fy - 6, fw + 12, fh + 12);
      const art = c.createLinearGradient(fx, fy, fx, fy + fh);
      art.addColorStop(0, mix(colors.sky, '#1e2d4a', 0.5)); art.addColorStop(1, mix(colors.snow, colors.horizon, 0.4));
      c.fillStyle = art; c.fillRect(fx, fy, fw, fh);
      pineSilhouette(c, fx + fw / 2, fy + fh * 0.95, fh * 0.7, '#0f2a24');
    }
    for (const cx of [shx + w * 0.15, shx + w * 0.17]) { c.fillStyle = '#f1e6cc'; c.fillRect(cx, h * 0.34 - h * 0.045, 7, h * 0.045); }
    // Plante en pot.
    const px = w * 0.86;
    c.fillStyle = '#8a4b32'; c.beginPath(); c.moveTo(px - 20, h * 0.7); c.lineTo(px + 20, h * 0.7); c.lineTo(px + 14, floorY + h * 0.02); c.lineTo(px - 14, floorY + h * 0.02); c.fill();
    for (let i = 0; i < 12; i++) {
      c.save(); c.translate(px, h * 0.7); c.rotate((i / 11 - 0.5) * 2.2);
      c.fillStyle = mix('#1f5a3a', '#4aa36b', rng()); c.beginPath(); c.ellipse(0, -h * 0.07, 9, h * 0.07, 0, 0, 7); c.fill(); c.restore();
    }
    // Plinthe d'ombre au sol et vignette douce des coins.
    const corner = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
    corner.addColorStop(0, 'rgba(0,0,0,0)'); corner.addColorStop(1, 'rgba(8,3,6,0.55)');
    c.fillStyle = corner; c.fillRect(0, 0, w, h);
  });
  const lampPos = [{ x: w * 0.2, y: h * 0.36, r: h * 0.42, color: '#ffcf86', amp: 0.04 }];
  const floorLight = layer(w, h, (c) => {
    const beam = c.createLinearGradient(0, floorY, 0, h);
    beam.addColorStop(0, 'rgba(177,208,255,0.12)');
    beam.addColorStop(1, 'rgba(177,208,255,0)');
    c.fillStyle = beam;
    c.beginPath(); c.moveTo(win.x, floorY); c.lineTo(win.x + win.w, floorY);
    c.lineTo(w * 0.9, h); c.lineTo(w * 0.1, h); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(25,35,48,0.16)'; c.lineWidth = Math.max(2, w * 0.005);
    c.beginPath(); c.moveTo(w * 0.5, floorY); c.lineTo(w * 0.5, h); c.stroke();
  });
  const candles = [w * 0.91, w * 0.93].map((x) => ({ x, y: h * (0.34 - 0.045) }));
  return { kind: 'room', view, room, win, lampPos, floorY, candles,
    floorLight,
    glow: glowSprite('#ffcf86', 128, 0.6), warm: glowSprite('#ff9a4d', 128, 0.5),
    moonGlow: glowSprite('#bcd4ff', 128, 0.25) };
}

// --------------------------------------------------------------------------
// Chalet en rondins
// --------------------------------------------------------------------------
function bakeCabin(w, h, colors) {
  const wins = [{ x: w * 0.12, y: h * 0.22, w: w * 0.2, h: h * 0.34 }, { x: w * 0.68, y: h * 0.22, w: w * 0.2, h: h * 0.34 }];
  const views = wins.map((wn) => nightView(wn.w, wn.h, colors, 0.55));
  const room = layer(w, h, (c) => {
    const rng = random(77);
    const logH = h * 0.085;
    for (let y = 0, row = 0; y < h; y += logH, row++) {
      woodGrain(c, 0, y, w, logH, mix('#7a4f2e', '#4d2f1b', (row % 3) / 3 + rng() * 0.2), rng, 5);
      c.fillStyle = rgba('#000000', 0.45); c.fillRect(0, y + logH - 2, w, 3);
      const ends = c.createRadialGradient(0, y + logH / 2, 0, 0, y + logH / 2, logH * 0.55);
      ends.addColorStop(0, '#c99a62'); ends.addColorStop(1, '#6c4528');
      c.fillStyle = ends; c.beginPath(); c.ellipse(row % 2 ? 6 : 14, y + logH / 2, logH * 0.5, logH * 0.46, 0, 0, 7); c.fill();
      c.beginPath(); c.ellipse(w - (row % 2 ? 6 : 14), y + logH / 2, logH * 0.5, logH * 0.46, 0, 0, 7); c.fill();
    }
    const floorY = h * 0.84;
    const floor = c.createLinearGradient(0, floorY, 0, h);
    floor.addColorStop(0, '#4b2e1c'); floor.addColorStop(1, '#25150c');
    c.fillStyle = floor; c.fillRect(0, floorY, w, h - floorY);
    c.strokeStyle = rgba('#000000', 0.35);
    for (let i = 0; i < 14; i++) { c.beginPath(); c.moveTo(w / 2 + (i - 7) * w * 0.03, floorY); c.lineTo(w / 2 + (i - 7) * w * 0.12, h); c.stroke(); }
    for (const wn of wins) {
      c.fillStyle = '#3a2314'; c.fillRect(wn.x - 12, wn.y - 12, wn.w + 24, wn.h + 24);
      c.globalCompositeOperation = 'destination-out'; c.fillRect(wn.x, wn.y, wn.w, wn.h); c.globalCompositeOperation = 'source-over';
      c.fillStyle = '#4e301c'; c.fillRect(wn.x + wn.w / 2 - 3, wn.y, 6, wn.h); c.fillRect(wn.x, wn.y + wn.h / 2 - 3, wn.w, 6);
      c.fillStyle = '#5a3a24'; c.fillRect(wn.x - 20, wn.y + wn.h + 10, wn.w + 40, 12);
      c.fillStyle = rgba('#ffffff', 0.9);                       // neige sur le rebord
      c.beginPath(); c.moveTo(wn.x - 18, wn.y + wn.h + 10); c.quadraticCurveTo(wn.x + wn.w / 2, wn.y + wn.h - 10, wn.x + wn.w + 18, wn.y + wn.h + 10); c.fill();
      // Givre dans les coins.
      c.strokeStyle = rgba('#e8f6ff', 0.55); c.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const a = rng() * 1.4, len = wn.w * (0.05 + rng() * 0.1);
        for (const [cx, cy, sx, sy] of [[wn.x, wn.y + wn.h, 1, -1], [wn.x + wn.w, wn.y + wn.h, -1, -1]]) {
          c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + sx * Math.cos(a) * len, cy + sy * Math.sin(a) * len); c.stroke();
        }
      }
    }
    // Pile de bois et bottes de poutres.
    for (let i = 0; i < 18; i++) {
      const col = i % 6, row = Math.floor(i / 6);
      const lx = w * 0.46 + col * 24 + (row % 2) * 12, ly = floorY + h * 0.06 - row * 24;
      c.fillStyle = '#5b3a22'; c.beginPath(); c.arc(lx, ly, 12, 0, 7); c.fill();
      c.fillStyle = '#c99a62'; c.beginPath(); c.arc(lx, ly, 8.5, 0, 7); c.fill();
      c.strokeStyle = rgba('#7a5230', 0.6); c.beginPath(); c.arc(lx, ly, 4.5, 0, 7); c.stroke();
    }
    // Étagère et tapis en peau.
    woodGrain(c, w * 0.4, h * 0.2, w * 0.2, 10, '#3a2314', rng, 2);
    for (let i = 0; i < 4; i++) { c.fillStyle = ['#a02a36', '#d9a441', '#2f5a5e', '#e8dec8'][i]; c.fillRect(w * 0.42 + i * 24, h * 0.2 - 26, 16, 26); }
    c.fillStyle = '#9c8a74'; c.save(); c.translate(w * 0.3, h * 0.93); c.scale(1, 0.22);
    c.beginPath(); c.arc(0, 0, w * 0.13, 0, 7); c.fill(); c.restore();
    const corner = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
    corner.addColorStop(0, 'rgba(0,0,0,0)'); corner.addColorStop(1, 'rgba(10,4,0,0.6)');
    c.fillStyle = corner; c.fillRect(0, 0, w, h);
  });
  // Guirlande lumineuse : points d'accroche sur une chaîne en festons.
  const bulbs = [];
  const span = 5;
  for (let s = 0; s < span; s++) {
    const x0 = w * (s / span), x1 = w * ((s + 1) / span);
    for (let k = 0; k <= 7; k++) {
      const u = k / 7;
      bulbs.push({ x: x0 + (x1 - x0) * u, y: h * 0.09 + Math.sin(u * Math.PI) * h * 0.06 + (s % 2) * 3,
        hue: ['#ffcf6b', '#ff7a7a', '#7affc0', '#8ec7ff'][(s * 8 + k) % 4], phase: (s * 8 + k) * 1.7 });
    }
  }
  const bulbGlows = Object.fromEntries([...new Set(bulbs.map((bulb) => bulb.hue))]
    .map((hue) => [hue, glowSprite(hue, 48, 0.9)]));
  return { kind: 'cabin', wins, views, room, bulbs, glow: glowSprite('#ffc977', 128, 0.7),
    warm: glowSprite('#ff8a3d', 128, 0.6), bulbGlows };
}

// --------------------------------------------------------------------------
// Ville nocturne
// --------------------------------------------------------------------------
function bakeCity(w, h, colors) {
  const sky = layer(w, h, (c) => {
    const g = c.createLinearGradient(0, 0, 0, h * 0.8);
    g.addColorStop(0, mix(colors.sky, '#000000', 0.2)); g.addColorStop(0.7, mix(colors.sky, colors.horizon, 0.55));
    g.addColorStop(1, mix(colors.horizon, '#ffb070', 0.25));
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    const rng = random(5);
    for (let i = 0; i < 90; i++) { c.fillStyle = rgba(colors.snow, 0.15 + rng() * 0.5); c.beginPath(); c.arc(rng() * w, rng() * h * 0.4, 0.4 + rng() * 0.8, 0, 7); c.fill(); }
    const mx = w * 0.82, my = h * 0.17;
    const mg = c.createRadialGradient(mx, my, 0, mx, my, h * 0.3);
    mg.addColorStop(0, rgba(colors.snow, 0.35)); mg.addColorStop(1, rgba(colors.snow, 0));
    c.fillStyle = mg; c.fillRect(0, 0, w, h);
    c.fillStyle = '#f3f5e9'; c.beginPath(); c.arc(mx, my, h * 0.042, 0, 7); c.fill();
  });
  const lights = [];
  const skylines = [0, 1, 2].map((depth) => layer(w, h, (c) => {
    const rng = random(900 + depth * 13);
    const base = h * (0.66 + depth * 0.09), tone = mix(colors.sky, '#000000', 0.25 + depth * 0.22);
    let x = -10;
    while (x < w) {
      const bw = w * (0.035 + rng() * 0.05), bh = h * (0.12 + rng() * (0.34 - depth * 0.08));
      const top = base - bh;
      const bg = c.createLinearGradient(x, top, x + bw, top);
      bg.addColorStop(0, mix(tone, '#ffffff', 0.04)); bg.addColorStop(1, tone);
      c.fillStyle = bg; c.fillRect(x, top, bw, h - top);
      c.fillStyle = rgba('#ffffff', 0.85); c.fillRect(x - 1, top - 3, bw + 2, 4);     // neige sur le toit
      if (rng() > 0.7) { c.fillStyle = tone; c.fillRect(x + bw * 0.45, top - bh * 0.18, 3, bh * 0.18); }
      const cw = 5 + depth, ch = 7 + depth;
      for (let wy = top + 12; wy < base - 8; wy += ch + 7) {
        for (let wx = x + 6; wx < x + bw - cw - 4; wx += cw + 6) {
          if (rng() > 0.46 - depth * 0.1) continue;
          const warm = rng() > 0.25;
          const col = warm ? (rng() > 0.5 ? '#ffd78a' : '#ffb35a') : '#bfe3ff';
          c.fillStyle = rgba(col, 0.8 - depth * 0.2); c.fillRect(wx, wy, cw, ch);
          if (depth === 0 && rng() > 0.8) lights.push({ x: wx + cw / 2, y: wy + ch / 2, phase: rng() * 30, col });
        }
      }
      x += bw + w * 0.004;
    }
  }));
  const street = layer(w, h, (c) => {
    const base = h * 0.88;
    const road = c.createLinearGradient(0, base, 0, h);
    road.addColorStop(0, '#1a1c24'); road.addColorStop(1, '#0c0d12');
    c.fillStyle = road; c.fillRect(0, base, w, h - base);
    c.fillStyle = '#e8f1f8'; c.fillRect(0, base - 9, w, 12);        // trottoir enneigé
    c.fillStyle = rgba('#ffffff', 0.55); for (let x = 0; x < w; x += w * 0.08) c.fillRect(x, base + (h - base) * 0.5, w * 0.04, 3);
    // Réverbères.
    for (let i = 0; i < 5; i++) {
      const x = w * (0.1 + i * 0.2), top = h * 0.7;
      c.fillStyle = '#0b0d12'; c.fillRect(x - 2, top, 4, base - top);
      c.fillRect(x - 2, top, 18, 3);
    }
  });
  const lamps = [0, 1, 2, 3, 4].map((i) => ({ x: w * (0.1 + i * 0.2) + 16, y: h * 0.7 + 4 }));
  return { kind: 'city', sky, skylines, street, lights, lamps, glow: glowSprite('#ffd08a', 128, 0.65),
    pointGlow: glowSprite('#ffffff', 32, 0.9) };
}

// --------------------------------------------------------------------------
// Fenêtre givrée
// --------------------------------------------------------------------------
function bakeFrost(w, h, colors) {
  const city = layer(w, h, (c) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, mix(colors.sky, '#000000', 0.25)); g.addColorStop(1, mix(colors.sky, colors.horizon, 0.7));
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    const rng = random(404), tints = ['#ffb347', '#ff6b6b', '#ffe27a', '#6be3a5', '#8fd3ff', '#ffffff'];
    for (let i = 0; i < 70; i++) {
      const r = h * (0.015 + rng() * 0.05), x = rng() * w, y = h * (0.3 + rng() * 0.65);
      const col = tints[Math.floor(rng() * tints.length)];
      const rg = c.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, rgba(col, 0.5)); rg.addColorStop(0.8, rgba(col, 0.28)); rg.addColorStop(1, rgba(col, 0));
      c.fillStyle = rg; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
    }
  });
  const frost = layer(w, h, (c) => {
    const rng = random(8);
    // Voile blanc dense sur les bords, vitre claire au centre.
    const veil = c.createRadialGradient(w / 2, h * 0.5, Math.min(w, h) * 0.18, w / 2, h * 0.5, Math.max(w, h) * 0.62);
    veil.addColorStop(0, 'rgba(225,243,255,0.04)'); veil.addColorStop(0.65, 'rgba(225,243,255,0.35)'); veil.addColorStop(1, 'rgba(235,248,255,0.85)');
    c.fillStyle = veil; c.fillRect(0, 0, w, h);
    // Cristaux fractals poussant depuis les angles.
    c.lineCap = 'round';
    const branch = (x, y, a, len, depth) => {
      if (depth <= 0 || len < 3) return;
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      c.strokeStyle = rgba('#ffffff', 0.35 + depth * 0.09); c.lineWidth = Math.max(0.5, depth * 0.45);
      c.beginPath(); c.moveTo(x, y); c.lineTo(x2, y2); c.stroke();
      branch(x2, y2, a + 0.5 + rng() * 0.2, len * 0.62, depth - 1);
      branch(x2, y2, a - 0.5 - rng() * 0.2, len * 0.62, depth - 1);
      if (rng() > 0.5) branch(x2, y2, a + (rng() - 0.5) * 0.3, len * 0.7, depth - 1);
    };
    for (let i = 0; i < 60; i++) {
      const edge = rng(); let x, y, a;
      if (edge < 0.4) { x = rng() * w; y = h; a = -Math.PI / 2 + (rng() - 0.5) * 1.2; }
      else if (edge < 0.6) { x = rng() * w; y = 0; a = Math.PI / 2 + (rng() - 0.5) * 1.2; }
      else if (edge < 0.8) { x = 0; y = rng() * h; a = (rng() - 0.5) * 1.2; }
      else { x = w; y = rng() * h; a = Math.PI + (rng() - 0.5) * 1.2; }
      branch(x, y, a, Math.min(w, h) * (0.06 + rng() * 0.1), 5);
    }
    // Gouttes de condensation.
    for (let i = 0; i < 40; i++) {
      const x = rng() * w, y = h * (0.15 + rng() * 0.8), r = 2 + rng() * 4;
      c.fillStyle = rgba('#ffffff', 0.18); c.beginPath(); c.ellipse(x, y, r * 0.8, r, 0, 0, 7); c.fill();
      c.fillStyle = rgba('#ffffff', 0.5); c.beginPath(); c.arc(x - r * 0.25, y - r * 0.3, r * 0.25, 0, 7); c.fill();
    }
    // Cadre et croisillon en bois blanc.
    const fr = Math.min(w, h) * 0.04;
    c.fillStyle = '#ece5d8';
    c.fillRect(0, 0, w, fr); c.fillRect(0, h - fr, w, fr); c.fillRect(0, 0, fr, h); c.fillRect(w - fr, 0, fr, h);
    c.fillRect(w / 2 - fr / 3, 0, fr * 0.66, h); c.fillRect(0, h * 0.5 - fr / 3, w, fr * 0.66);
    c.fillStyle = rgba('#000000', 0.18);
    c.fillRect(fr, fr, w - fr * 2, 3); c.fillRect(fr, fr, 3, h - fr * 2);
    // Neige accumulée en bas.
    c.fillStyle = '#f4f9ff';
    c.beginPath(); c.moveTo(0, h);
    for (let x = 0; x <= w + 12; x += 12) c.lineTo(x, h - fr * 0.9 - Math.sin(x / w * 9) * fr * 0.55 - Math.sin(x / w * 23) * fr * 0.2);
    c.lineTo(w, h); c.fill();
  });
  return { kind: 'frost', city, frost, glow: glowSprite('#ffd9a0', 128, 0.4) };
}

// --------------------------------------------------------------------------
// Rendu animé
// --------------------------------------------------------------------------
function flicker(t, phase, speed = 1) {
  return 0.8 + 0.12 * Math.sin(t * 3.1 * speed + phase) + 0.08 * Math.sin(t * 7.3 * speed + phase * 2.1);
}

const lightAlpha = (value) => Math.max(0, Math.min(1, value));

function drawRoom(c, w, h, t, s, opacity, motion, sx, sy, lighting) {
  const { win } = s;
  c.globalAlpha = opacity; c.drawImage(s.view, win.x * sx, win.y * sy, win.w * sx, win.h * sy);
  if (motion) {
    c.globalAlpha = opacity;
    drawFlakes(c, win.x * sx, win.y * sy, win.w * sx, win.h * sy, t * 1.2, Math.round(40 + win.w * win.h / 7000), '#ffffff');
  }
  c.globalAlpha = opacity; c.drawImage(s.room, 0, 0, w, h);
  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = lightAlpha(opacity * lighting * 0.7);
  c.drawImage(s.floorLight, 0, 0, w, h);
  for (const lamp of s.lampPos) {
    const k = motion ? flicker(t, 0, 0.3) : 0.85, r = lamp.r * sy;
    c.globalAlpha = lightAlpha(opacity * lighting * 0.6 * k);
    c.drawImage(s.glow, lamp.x * sx - r, lamp.y * sy - r * 0.85, r * 2, r * 1.9);
  }
  c.globalAlpha = lightAlpha(opacity * lighting * 0.55);
  c.drawImage(s.moonGlow, (win.x - win.w * 0.2) * sx, (win.y + win.h * 0.3) * sy, win.w * 1.4 * sx, win.h * 1.3 * sy);
  c.globalAlpha = lightAlpha(opacity * lighting * 0.22 * (motion ? flicker(t, 4, 0.5) : 0.85));
  c.drawImage(s.warm, w * 0.25, h * 0.72, w * 0.5, h * 0.3);
  for (const [i, candle] of s.candles.entries()) {
    const glow = Math.min(w, h) * 0.065;
    const pulse = motion ? flicker(t, i * 4, 1.1) : 0.85;
    c.globalAlpha = lightAlpha(opacity * lighting * 0.5 * pulse);
    c.drawImage(s.warm, candle.x * sx - glow / 2, candle.y * sy - glow / 2, glow, glow);
    c.globalAlpha = lightAlpha(opacity * lighting * pulse);
    c.fillStyle = '#ffe0a0';
    c.beginPath(); c.ellipse(candle.x * sx + 3.5 * sx, candle.y * sy - 2 * sy,
      Math.max(0.7, 1.5 * sx), Math.max(1, 3 * sy), 0, 0, Math.PI * 2); c.fill();
  }
  c.globalCompositeOperation = 'source-over';
}

function drawCabin(c, w, h, t, s, opacity, motion, sx, sy, lighting) {
  s.wins.forEach((wn, i) => {
    c.globalAlpha = opacity; c.drawImage(s.views[i], wn.x * sx, wn.y * sy, wn.w * sx, wn.h * sy);
    if (motion) drawFlakes(c, wn.x * sx, wn.y * sy, wn.w * sx, wn.h * sy, t * 1.1 + i * 13, 34, '#ffffff', 0.7);
  });
  c.globalAlpha = opacity; c.drawImage(s.room, 0, 0, w, h);
  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = lightAlpha(opacity * lighting * 0.5 * (motion ? flicker(t, 1, 1.4) : 0.85));
  c.drawImage(s.warm, w * 0.02, h * 0.55, w * 0.96, h * 0.6);
  c.globalAlpha = lightAlpha(opacity * lighting * 0.3 * (motion ? flicker(t, 9, 0.7) : 0.85));
  c.drawImage(s.glow, w * 0.3, h * 0.05, w * 0.4, h * 0.5);
  const size = Math.min(w, h) * 0.05;
  for (const b of s.bulbs) {
    const k = motion ? 0.55 + 0.45 * Math.sin(t * 2 + b.phase) : 0.85;
    c.globalAlpha = lightAlpha(opacity * lighting * (0.25 + 0.65 * Math.max(0, k)));
    c.fillStyle = b.hue; c.beginPath(); c.arc(b.x * sx, b.y * sy, Math.max(2, size * 0.09), 0, 7); c.fill();
    c.globalAlpha = lightAlpha(opacity * lighting * 0.5 * Math.max(0, k));
    c.drawImage(s.bulbGlows[b.hue], b.x * sx - size / 2, b.y * sy - size / 2, size, size);
  }
  c.globalCompositeOperation = 'source-over';
}

function drawCity(c, w, h, t, s, opacity, motion, sx, sy, lighting) {
  c.globalAlpha = opacity; c.drawImage(s.sky, 0, 0, w, h);
  const pan = motion ? Math.sin(t * 0.03) * w * 0.004 : 0;
  s.skylines.forEach((sl, i) => c.drawImage(sl, pan * (3 - i), 0, w, h));
  c.globalCompositeOperation = 'lighter';
  for (const l of s.lights) {
    const k = motion ? Math.max(0, Math.sin(t * 0.9 + l.phase)) : 0.5;
    if (k < 0.5) continue;
    c.globalAlpha = lightAlpha(opacity * lighting * (k - 0.5) * 0.9); c.fillStyle = l.col;
    c.fillRect(l.x * sx - 3, l.y * sy - 4, 6, 8);
  }
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = opacity; c.drawImage(s.street, 0, 0, w, h);
  c.globalCompositeOperation = 'lighter';
  const lampR = h * 0.16;
  for (const lamp of s.lamps) {
    c.globalAlpha = lightAlpha(opacity * lighting * 0.65 * (motion ? flicker(t, lamp.x, 0.25) : 0.85));
    c.drawImage(s.glow, lamp.x * sx - lampR, lamp.y * sy - lampR * 0.4, lampR * 2, lampR * 1.6);
    c.globalAlpha = lightAlpha(opacity * lighting * 0.25);
    c.drawImage(s.glow, lamp.x * sx - lampR * 0.35, h * 0.87, lampR * 0.7, h * 0.14);
  }
  if (motion) {
    // Voitures : paires de phares blancs (vers la droite) et feux rouges.
    for (let i = 0; i < 6; i++) {
      const dir = i % 2 ? -1 : 1, lane = 0.925 + (i % 2) * 0.04;
      const u = ((t * (0.03 + (i % 3) * 0.012) * dir + i * 0.17) % 1 + 1) % 1;
      const x = u * (w + 100) - 50, y = lane * h;
      c.globalAlpha = lightAlpha(opacity * lighting * 0.9);
      c.fillStyle = dir > 0 ? '#ffffff' : '#ff4d4d';
      c.fillRect(x, y, 4, 3); c.fillRect(x + 22, y, 4, 3);
      c.globalAlpha = lightAlpha(opacity * lighting * 0.5); const g = 34;
      c.drawImage(s.pointGlow, x - g / 2 + 2, y - g / 2 + 1, g, g); c.drawImage(s.pointGlow, x + 22 - g / 2 + 2, y - g / 2 + 1, g, g);
    }
  }
  c.globalCompositeOperation = 'source-over';
  if (motion) {
    c.globalAlpha = opacity;
    drawFlakes(c, 0, 0, w, h, t * 1.4, Math.min(160, Math.round(w * h / 9000)), '#ffffff', 1.2);
  }
}

function drawFrost(c, w, h, t, s, opacity, motion, lighting) {
  c.globalAlpha = opacity; c.drawImage(s.city, 0, 0, w, h);
  c.globalCompositeOperation = 'lighter';
  // Les halos de la ville pulsent doucement derrière le givre.
  c.globalAlpha = lightAlpha(opacity * lighting * 0.18 * (motion ? flicker(t, 2, 0.4) : 0.85));
  c.drawImage(s.glow, 0, h * 0.3, w, h * 0.8);
  c.globalCompositeOperation = 'source-over';
  if (motion) { c.globalAlpha = opacity; drawFlakes(c, 0, 0, w, h, t * 1.2, 70, '#ffffff', 0.9); }
  c.globalAlpha = opacity; c.drawImage(s.frost, 0, 0, w, h);
}

export const INTERIOR_BACKGROUNDS = new Set(['living-room', 'log-cabin', 'night-city', 'frosted-window']);
export const ENCLOSED_BACKGROUNDS = new Set(['living-room', 'log-cabin', 'frosted-window']);

export function createInteriorRenderer() {
  let key = '', baked = null, frame = null;
  return {
    draw(c, w, h, t, cfg, colors, motion, opacity) {
      if (!(w > 0 && h > 0)) return;
      const scale = Math.min(1, 1440 / w, 900 / h, Math.sqrt(1300000 / (w * h)));
      const bw = Math.max(1, Math.ceil(w * scale)), bh = Math.max(1, Math.ceil(h * scale));
      const nextKey = JSON.stringify([bw, bh, cfg.background, colors]);
      if (key !== nextKey) {
        const bake = { 'living-room': bakeLivingRoom, 'log-cabin': bakeCabin, 'night-city': bakeCity, 'frosted-window': bakeFrost }[cfg.background];
        baked = bake(bw, bh, colors);
        frame = layer(bw, bh, () => {});
        key = nextKey;
      }
      const lightingValue = Number(cfg.backgroundLighting ?? 1);
      const lighting = Number.isFinite(lightingValue) ? Math.max(0, Math.min(2, lightingValue)) : 1;
      const ctx = frame.getContext('2d');
      ctx.clearRect(0, 0, bw, bh);
      ctx.save();
      const time = motion ? t : 0;
      if (motion && cfg.backgroundAnimation === 'kenburns') {
        const zoom = 1.02 + 0.01 * Math.sin(time * 0.07);
        const marginX = bw * (zoom - 1), marginY = bh * (zoom - 1);
        ctx.translate(-marginX * (0.5 + 0.35 * Math.sin(time * 0.04)),
          -marginY * (0.5 + 0.35 * Math.cos(time * 0.035)));
        ctx.scale(zoom, zoom);
      }
      if (baked.kind === 'room') drawRoom(ctx, bw, bh, time, baked, 1, motion, 1, 1, lighting);
      else if (baked.kind === 'cabin') drawCabin(ctx, bw, bh, time, baked, 1, motion, 1, 1, lighting);
      else if (baked.kind === 'city') drawCity(ctx, bw, bh, time, baked, 1, motion, 1, 1, lighting);
      else drawFrost(ctx, bw, bh, time, baked, 1, motion, lighting);
      ctx.restore();
      c.save(); c.beginPath(); c.rect(0, 0, w, h); c.clip();
      c.globalAlpha *= opacity;
      c.drawImage(frame, 0, 0, w, h);
      c.restore();
    },
  };
}
