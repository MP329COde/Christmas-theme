// Lightweight snow particle renderer. No Tauri-only APIs are used in the
// render path, so this file is directly testable via Playwright by
// loading index.html from a plain static server.

const canvas = document.getElementById('snow');
const ctx = canvas.getContext('2d');

let flakes = [];
let config = {
  density: 120,
  wind: 0.3,
  flakeSize: 3,
  accumulate: true,
  color: '#ffffff',
};

let accumulation = []; // per-column snow height, only used when accumulate=true
let running = true;
let rafId = null;

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  accumulation = new Array(Math.ceil(canvas.width / 4)).fill(0);
}
window.addEventListener('resize', resize);
resize();

function makeFlake() {
  return {
    x: Math.random() * canvas.width,
    y: Math.random() * -canvas.height,
    r: config.flakeSize * (0.5 + Math.random()),
    speed: 0.6 + Math.random() * 1.4,
    drift: Math.random() * Math.PI * 2,
  };
}

export function setDensity(density) {
  config.density = density;
  if (flakes.length < density) {
    while (flakes.length < density) flakes.push(makeFlake());
  } else {
    flakes.length = density;
  }
}

export function setConfig(partial) {
  config = { ...config, ...partial };
  setDensity(config.density);
}

export function getParticleCount() {
  return flakes.length;
}

export function stop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
}

export function start() {
  if (!running) {
    running = true;
    tick();
  }
}

function tick() {
  if (!running) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = config.color;

  for (const f of flakes) {
    f.y += f.speed;
    f.drift += 0.01;
    f.x += Math.sin(f.drift) * config.wind;

    const col = Math.max(0, Math.min(accumulation.length - 1, Math.floor(f.x / 4)));
    const groundY = config.accumulate
      ? canvas.height - accumulation[col]
      : canvas.height;

    if (f.y > groundY) {
      if (config.accumulate && accumulation[col] < 60) {
        accumulation[col] += 0.15;
      }
      Object.assign(f, makeFlake(), { y: -10 });
    }

    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    ctx.fill();
  }

  if (config.accumulate) {
    ctx.beginPath();
    ctx.moveTo(0, canvas.height);
    for (let i = 0; i < accumulation.length; i++) {
      ctx.lineTo(i * 4, canvas.height - accumulation[i]);
    }
    ctx.lineTo(canvas.width, canvas.height);
    ctx.closePath();
    ctx.fill();
  }

  rafId = requestAnimationFrame(tick);
}

setDensity(config.density);
tick();

// Expose for Playwright / manual debugging without a module bundler step.
window.snowOverlay = { setDensity, setConfig, getParticleCount, start, stop };
