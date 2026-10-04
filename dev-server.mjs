// Serveur LOCAL pour tester avant de mettre en ligne : même logique que sur Netlify,
// mais les données sont des fichiers JSON dans le dossier data/.  Usage : npm run dev
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createHandler, SECURITY_HEADERS } from './lib/shop.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 8888;

// Lit ADMIN_PASSWORD_HASH depuis .env (créé par : npm run hash-password -- --local)
function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  } catch { /* pas de .env */ }
  return env;
}

function fileStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = (key) => path.join(DATA_DIR, encodeURIComponent(key));
  const etagOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
  const read = (key) => {
    try {
      return fs.readFileSync(file(key));
    } catch {
      return null;
    }
  };
  return {
    async readJSON(key) {
      const buf = read(key);
      return buf ? { value: JSON.parse(buf.toString('utf8')), etag: etagOf(buf) } : { value: null, etag: null };
    },
    // Synchrone de bout en bout : la vérification et l'écriture ne peuvent pas être entrelacées
    async writeJSON(key, value, etag) {
      const current = read(key);
      if (etag === null && current) return false;
      if (etag && (!current || etagOf(current) !== etag)) return false;
      fs.writeFileSync(file(key) + '.tmp', JSON.stringify(value, null, 2));
      fs.renameSync(file(key) + '.tmp', file(key));
      return true;
    },
    async putFile(key, bytes) {
      fs.writeFileSync(file(key), bytes);
    },
    async getFile(key) {
      const buf = read(key);
      return buf ? { bytes: buf } : null;
    },
    async remove(key) {
      fs.rmSync(file(key), { force: true });
    },
  };
}

const env = loadEnv();
const handle = createHandler(fileStorage(), { env, secureCookie: false });

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  if (pathname === '/admin') {
    res.writeHead(301, { Location: '/admin/' });
    return res.end();
  }
  let file = path.resolve(PUBLIC_DIR, '.' + pathname);
  if (pathname.endsWith('/')) file = path.join(file, 'index.html');
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) file = null;
  fs.readFile(file || '', (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Introuvable');
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 6_000_000) {
      res.writeHead(413);
      return res.end();
    }
    chunks.push(c);
  }
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await handle(request, { ip: req.socket.remoteAddress });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Boutique : http://localhost:${PORT}/`);
  console.log(`Admin    : http://localhost:${PORT}/admin/`);
  if (!env.ADMIN_PASSWORD_HASH) console.log('⚠  Pas de mot de passe admin. Lancez : npm run hash-password -- --local');
});
