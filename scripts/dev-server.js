// Minimal static file server for `src/` and `themes/`, used to drive the
// settings UI and snow overlay with Playwright without needing a bundler
// or the native Tauri shell. Not used in the production app (Tauri serves
// these files itself in dev/build).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, '..');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const port = process.env.PORT ? Number(process.env.PORT) : 4173;

const server = http.createServer(async (req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/settings/index.html';
  if (urlPath === '/overlay') urlPath = '/overlay/index.html';

  const filePath = path.join(
    projectRoot,
    urlPath.startsWith('/themes/') ? urlPath : path.join('src', urlPath)
  );

  if (!filePath.startsWith(projectRoot)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(port, () => {
  console.log(`Dev server listening on http://localhost:${port}`);
});
