// Local-development static file serving with an explicit allowlist.
// Only public site files are reachable; everything else is 404.
import { realpathSync, statSync, createReadStream } from 'node:fs';
import { join, sep, extname } from 'node:path';

const EXACT = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/work.html', 'work.html'],
  ['/beethoven.html', 'beethoven.html'],
  ['/notebook.html', 'notebook.html'],
  ['/transcript.html', 'transcript.html'],
  ['/transcript.json', 'transcript.json'],
  ['/data/catalog.json', 'data/catalog.json'],
  ['/assets/vendor/abcjs-basic-min.js', 'assets/vendor/abcjs-basic-min.js'],
  ['/assets/vendor/abcjs_basic.LICENSE', 'assets/vendor/abcjs_basic.LICENSE'],
]);
const DIRS = new Set(['assets', 'scores']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.abc': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};
const BLOCKED_EXT = new Set(['.sqlite', '.db', '.env', '.mjs.map', '.sh', '.md']);

// Maps a raw request path (no query) to a relative file path, or null.
export function resolvePublicPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.length > 512) return null;
  if (rawPath.includes('\\') || rawPath.includes('\0')) return null;
  if (EXACT.has(rawPath)) return EXACT.get(rawPath);
  const parts = rawPath.split('/');
  // Exactly "/<dir>/<file>", compared on the raw (still percent-encoded) path:
  // any '%' fails NAME, so encoded dots or slashes cannot sneak through.
  if (parts.length !== 3 || parts[0] !== '' || !DIRS.has(parts[1])) return null;
  const name = parts[2];
  if (!NAME.test(name) || !TYPES[extname(name).toLowerCase()] || BLOCKED_EXT.has(extname(name).toLowerCase())) return null;
  return `${parts[1]}/${name}`;
}

export function serveStatic(req, res, root, rawPath, sendError) {
  const rel = resolvePublicPath(rawPath);
  if (!rel) return sendError(res, 404, 'not_found', 'Not found');
  let file;
  try {
    const realRoot = realpathSync(root);
    file = realpathSync(join(realRoot, rel));
    const allowedPrefix = rel.includes('/') ? realpathSync(join(realRoot, rel.split('/')[0])) + sep : realRoot + sep;
    if (!file.startsWith(allowedPrefix)) return sendError(res, 404, 'not_found', 'Not found');
    const st = statSync(file);
    if (!st.isFile()) return sendError(res, 404, 'not_found', 'Not found');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
  } catch {
    return sendError(res, 404, 'not_found', 'Not found');
  }
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
