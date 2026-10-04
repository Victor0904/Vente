// Logique de la boutique (API), indépendante du stockage.
// Le stockage est fourni par l'appelant : Netlify Blobs en ligne, fichiers JSON en local.
//
// Interface attendue du stockage :
//   readJSON(key)                 -> { value, etag }   (value = null si absent)
//   writeJSON(key, value, etag)   -> true si écrit      (etag null = seulement si absent, undefined = sans condition)
//   putFile(key, bytes, type), getFile(key) -> { bytes, contentType } | null, remove(key)
import crypto from 'node:crypto';

const SESSION_TTL = 8 * 3600 * 1000;
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_ORDERS_PER_HOUR = 10;
const MAX_QTY = 20; // par article et par commande
const MAX_TRACK_FAILS_PER_HOUR = 15;
// Code de suivi : 8 caractères parmi 32 (sans 0/O ni 1/I) = ~1 100 milliards de combinaisons
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_RE = /^[2-9A-HJ-NP-Z]{8}$/;
const STATUSES = ['pending', 'done', 'refused', 'cancelled'];
const IMG_RE = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
const IMG_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const newId = () => crypto.randomBytes(8).toString('hex');
const newTrackingCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
// Tolère les espaces, tirets et minuscules : « k7p2-9xq4 » = « K7P29XQ4 »
const normalizeCode = (value) => String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ipKey = (prefix, ip) => `${prefix}-${crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 24)}`;

function json(status, obj, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function cleanText(value, min, max, label) {
  const s = typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim() : '';
  if (s.length < min) throw new HttpError(400, `${label} : ${min} caractère(s) minimum.`);
  if (s.length > max) throw new HttpError(400, `${label} : ${max} caractères maximum.`);
  return s;
}

async function readJsonBody(req, limit) {
  if (!String(req.headers.get('content-type') || '').startsWith('application/json')) throw new HttpError(415, 'JSON attendu.');
  if (Number(req.headers.get('content-length') || 0) > limit) throw new HttpError(413, 'Requête trop volumineuse.');
  const text = await req.text();
  if (text.length > limit) throw new HttpError(413, 'Requête trop volumineuse.');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'JSON invalide.');
  }
}

// ---------- Mot de passe & sessions (cookies signés, sans état côté serveur) ----------

function parsePasswordHash(env) {
  const m = /^scrypt:(\d+):([a-f0-9]{32}):([a-f0-9]{128})$/.exec(String(env.ADMIN_PASSWORD_HASH || '').trim());
  return m ? { N: Number(m[1]), salt: Buffer.from(m[2], 'hex'), hash: Buffer.from(m[3], 'hex'), raw: m[0] } : null;
}

function verifyPassword(password, admin) {
  return new Promise((resolve) => {
    crypto.scrypt(password, admin.salt, 64, { N: admin.N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      resolve(!err && crypto.timingSafeEqual(key, admin.hash));
    });
  });
}

// Clé de signature dérivée de l'empreinte : changer le mot de passe déconnecte toutes les sessions
const sessionKey = (admin) => crypto.createHash('sha256').update('session:' + admin.raw).digest();

function signSession(admin) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL, n: newId() })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionKey(admin)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function checkSession(token, admin) {
  if (!token || !admin) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', sessionKey(admin)).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
  } catch {
    return false;
  }
}

function getCookie(req, name) {
  for (const part of String(req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// ---------- Handler ----------

export function createHandler(store, { env = {}, secureCookie = true } = {}) {
  const cookie = (value, maxAge) =>
    `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;

  // Lecture-modification-écriture protégée : si quelqu'un a écrit entre-temps, on recommence
  async function update(key, fallback, fn) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { value, etag } = await store.readJSON(key);
      const data = value ?? fallback();
      const result = await fn(data);
      if (await store.writeJSON(key, data, etag)) return result;
      await sleep(30 + Math.random() * 120);
    }
    throw new HttpError(503, 'Serveur occupé, réessayez.');
  }

  const DEFAULT_SETTINGS = { name: 'Vide-grenier', description: 'Seconde main · paiement à la livraison' };

  async function getSettings() {
    return { ...DEFAULT_SETTINGS, ...(await store.readJSON('settings')).value };
  }

  async function getProducts() {
    const { value } = await store.readJSON('products');
    if (value) return value;
    const seed = seedProducts();
    await store.writeJSON('products', seed, null);
    return (await store.readJSON('products')).value || seed;
  }

  function seedProducts() {
    const now = new Date().toISOString();
    return [
      { title: 'Lampe de bureau vintage', description: 'Métal vert, fonctionne parfaitement. Ampoule E27 fournie.', price: 1500 },
      { title: 'Vélo enfant 16 pouces', description: 'Pour 4-6 ans. Petites rayures, freins révisés.', price: 3500 },
      { title: 'Lot de 12 livres de poche', description: 'Romans policiers, bon état général.', price: 800 },
    ].map((p) => ({ id: newId(), ...p, images: [], createdAt: now, updatedAt: now }));
  }

  const publicProduct = ({ id, title, description, price, images }) => ({ id, title, description, price, images });

  function parseProductInput(body) {
    const title = cleanText(body.title, 1, 120, 'Titre');
    const description = cleanText(body.description ?? '', 0, 2000, 'Description');
    const price = Math.round(Number(body.price) * 100);
    if (!Number.isFinite(price) || price < 0 || price > 10_000_000) throw new HttpError(400, 'Prix invalide.');
    if (!Array.isArray(body.images) || body.images.length > 10) throw new HttpError(400, 'Images invalides (10 max).');
    const images = body.images.map(String);
    for (const url of images) {
      if (!url.startsWith('/api/img/') || !IMG_RE.test(url.slice(9))) throw new HttpError(400, 'Image invalide.');
    }
    return { title, description, price, images };
  }

  async function removeImages(urls) {
    await Promise.all(urls.map((u) => store.remove('img/' + u.slice(9)).catch(() => {})));
  }

  function detectImage(buf) {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
    return null;
  }

  function checkSameOrigin(req) {
    const origin = req.headers.get('origin');
    if (!origin) return;
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'Origine refusée.');
    }
    if (host !== new URL(req.url).host) throw new HttpError(403, 'Origine refusée.');
  }

  async function createOrder(body, ip) {
    const name = cleanText(body.name, 2, 80, 'Nom');
    const address = cleanText(body.address, 5, 300, 'Adresse');
    const phone = cleanText(body.phone, 8, 20, 'Téléphone');
    if (!/^\+?[0-9][0-9 .\-()]{6,18}[0-9]$/.test(phone)) throw new HttpError(400, 'Numéro de téléphone invalide.');
    if (body.payOnDelivery !== true) throw new HttpError(400, 'Vous devez accepter le paiement sur place.');
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50) {
      throw new HttpError(400, 'Panier vide ou invalide.');
    }

    // Pas de stock : le client choisit librement la quantité (1 à MAX_QTY par article)
    const qtyById = new Map();
    for (const it of body.items) {
      const id = typeof it === 'string' ? it : it && it.id;
      const qty = typeof it === 'string' ? 1 : Number(it && it.qty);
      if (typeof id !== 'string' || !Number.isInteger(qty) || qty < 1) throw new HttpError(400, 'Article invalide.');
      qtyById.set(id, Math.min((qtyById.get(id) || 0) + qty, MAX_QTY));
    }
    const all = await getProducts();
    const lines = [];
    for (const [id, qty] of qtyById) {
      const p = all.find((x) => x.id === id);
      if (!p) throw new HttpError(409, "Un article de votre panier n'est plus en vente. Retirez-le du panier.");
      lines.push({ p, qty });
    }

    await update(ipKey('orderrate', ip), () => [], (times) => {
      const recent = times.filter((t) => Date.now() - t < 3600_000);
      if (recent.length >= MAX_ORDERS_PER_HOUR) throw new HttpError(429, 'Trop de commandes. Réessayez plus tard.');
      times.splice(0, times.length, ...recent, Date.now());
    });

    return update('orders', () => ({ nextNo: 1, list: [] }), (doc) => {
      const now = new Date().toISOString();
      const order = {
        id: newId(),
        no: doc.nextNo++,
        code: newTrackingCode(),
        createdAt: now,
        updatedAt: now,
        status: 'pending',
        customer: { name, address, phone },
        items: lines.map(({ p, qty }) => ({ productId: p.id, title: p.title, price: p.price, qty })),
        total: lines.reduce((sum, { p, qty }) => sum + p.price * qty, 0),
      };
      doc.list.push(order);
      return order;
    });
  }

  // Les essais sont réservés AVANT la recherche (les requêtes parallèles ne contournent pas la limite),
  // puis les codes trouvés sont rendus : seuls les codes faux comptent.
  async function trackOrders(rawCodes, ip) {
    const codes = [...new Set(rawCodes.slice(0, 10).map(normalizeCode))];
    if (!codes.length || codes.some((c) => !CODE_RE.test(c))) throw new HttpError(400, 'Code de suivi invalide (8 caractères, ex. K7P2-9XQ4).');
    const key = ipKey('track', ip);
    await update(key, () => [], (fails) => {
      const recent = fails.filter((t) => Date.now() - t < 3600_000);
      if (recent.length + codes.length > MAX_TRACK_FAILS_PER_HOUR) {
        throw new HttpError(429, 'Trop de recherches. Réessayez dans une heure.');
      }
      fails.splice(0, fails.length, ...recent, ...codes.map(() => Date.now()));
    });
    const list = (await store.readJSON('orders')).value?.list || [];
    const found = codes.map((c) => list.find((o) => o.code === c)).filter(Boolean);
    if (found.length) {
      await update(key, () => [], (fails) => { fails.splice(fails.length - found.length, found.length); });
    }
    if (codes.length === 1 && !found.length) {
      await sleep(400);
      throw new HttpError(404, 'Aucune commande avec ce code. Vérifiez-le.');
    }
    return found.map((o) => ({
      no: o.no,
      code: o.code,
      status: o.status,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      items: o.items.map(({ title, price, qty }) => ({ title, price, qty: qty || 1 })),
      total: o.total,
      customer: { name: o.customer.name, address: o.customer.address },
    }));
  }

  async function login(req, ip) {
    const admin = parsePasswordHash(env);
    if (!admin) {
      throw new HttpError(503, env.ADMIN_PASSWORD_HASH
        ? 'La variable ADMIN_PASSWORD_HASH est mal copiée : collez la ligne « scrypt:16384:… » entière, sans guillemets ni espaces.'
        : 'Mot de passe admin non configuré : ajoutez la variable ADMIN_PASSWORD_HASH dans Netlify, puis redéployez.');
    }
    // L'essai est compté AVANT la vérification : des requêtes parallèles ne contournent pas la limite
    const key = ipKey('login', ip);
    await update(key, () => ({ fails: 0, lockedUntil: 0 }), (s) => {
      if (s.lockedUntil > Date.now()) {
        throw new HttpError(429, `Trop d'essais. Réessayez dans ${Math.ceil((s.lockedUntil - Date.now()) / 60000)} min.`);
      }
      s.fails += 1;
      if (s.fails >= MAX_LOGIN_FAILS) {
        s.lockedUntil = Date.now() + LOGIN_LOCK_MS;
        s.fails = 0;
      }
    });
    const body = await readJsonBody(req, 2_000);
    const ok = typeof body.password === 'string' && body.password.length <= 256 && (await verifyPassword(body.password, admin));
    if (!ok) {
      await sleep(800);
      throw new HttpError(401, 'Mot de passe incorrect.');
    }
    await store.remove(key).catch(() => {});
    return json(200, { ok: true }, { 'Set-Cookie': cookie(signSession(admin), SESSION_TTL / 1000) });
  }

  async function route(req, ip) {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;

    if (method === 'GET' && pathname === '/api/settings') return json(200, await getSettings());

    if (method === 'GET' && pathname === '/api/products') {
      return json(200, (await getProducts()).map(publicProduct));
    }

    const img = pathname.match(/^\/api\/img\/([a-f0-9]{32}\.(jpg|png|webp))$/);
    if (img && method === 'GET') {
      const file = await store.getFile('img/' + img[1]);
      if (!file) throw new HttpError(404, 'Image introuvable.');
      return new Response(file.bytes, {
        headers: { ...SECURITY_HEADERS, 'Content-Type': IMG_TYPES[img[2]], 'Cache-Control': 'public, max-age=31536000, immutable' },
      });
    }

    if (method === 'POST' && pathname === '/api/orders') {
      checkSameOrigin(req);
      const order = await createOrder(await readJsonBody(req, 20_000), ip);
      return json(201, { no: order.no, code: order.code, total: order.total });
    }

    if (method === 'POST' && pathname === '/api/track') {
      checkSameOrigin(req);
      const body = await readJsonBody(req, 2_000);
      return json(200, await trackOrders(Array.isArray(body.codes) ? body.codes : [body.code], ip));
    }

    if (!pathname.startsWith('/api/admin/')) throw new HttpError(404, 'Introuvable.');
    checkSameOrigin(req);
    if (method !== 'GET' && req.headers.get('x-requested-with') !== 'admin') throw new HttpError(403, 'Requête refusée.');

    if (method === 'POST' && pathname === '/api/admin/login') return login(req, ip);
    if (method === 'POST' && pathname === '/api/admin/logout') return json(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });

    if (!checkSession(getCookie(req, 'sid'), parsePasswordHash(env))) throw new HttpError(401, 'Non connecté.');

    if (method === 'GET' && pathname === '/api/admin/me') return json(200, { ok: true });

    if (method === 'PUT' && pathname === '/api/admin/settings') {
      const body = await readJsonBody(req, 2_000);
      const settings = {
        name: cleanText(body.name, 1, 60, 'Nom de la boutique'),
        description: cleanText(body.description ?? '', 0, 160, 'Description'),
      };
      await store.writeJSON('settings', settings);
      return json(200, settings);
    }
    if (method === 'GET' && pathname === '/api/admin/products') return json(200, await getProducts());

    if (method === 'POST' && pathname === '/api/admin/products') {
      const input = parseProductInput(await readJsonBody(req, 20_000));
      await getProducts(); // crée la liste d'exemple si besoin
      const now = new Date().toISOString();
      const product = { id: newId(), ...input, createdAt: now, updatedAt: now };
      await update('products', () => [], (list) => { list.unshift(product); });
      return json(201, publicProduct(product));
    }

    const productMatch = pathname.match(/^\/api\/admin\/products\/([a-f0-9]{16})$/);
    if (productMatch && (method === 'PUT' || method === 'DELETE')) {
      const input = method === 'PUT' ? parseProductInput(await readJsonBody(req, 20_000)) : null;
      const { product, removed } = await update('products', () => [], (list) => {
        const i = list.findIndex((p) => p.id === productMatch[1]);
        if (i < 0) throw new HttpError(404, 'Produit introuvable.');
        const old = list[i];
        if (input) {
          list[i] = { ...old, ...input, updatedAt: new Date().toISOString() };
          return { product: list[i], removed: old.images.filter((u) => !input.images.includes(u)) };
        }
        list.splice(i, 1);
        return { product: null, removed: old.images };
      });
      await removeImages(removed);
      return json(200, product ? publicProduct(product) : { ok: true });
    }

    if (method === 'POST' && pathname === '/api/admin/upload') {
      const body = await readJsonBody(req, 5_500_000);
      const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
      if (!m) throw new HttpError(400, 'Image invalide.');
      const buf = Buffer.from(m[1], 'base64');
      const ext = detectImage(buf);
      if (!ext) throw new HttpError(400, 'Format accepté : JPG, PNG ou WebP.');
      const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
      await store.putFile('img/' + name, buf, IMG_TYPES[ext]);
      return json(201, { url: `/api/img/${name}` });
    }

    // Image envoyée puis abandonnée (formulaire annulé) : supprimée si aucune annonce ne l'utilise
    const upMatch = pathname.match(/^\/api\/admin\/upload\/([a-f0-9]{32}\.(?:jpg|png|webp))$/);
    if (upMatch && method === 'DELETE') {
      const url = `/api/img/${upMatch[1]}`;
      if (!(await getProducts()).some((p) => p.images.includes(url))) await removeImages([url]);
      return json(200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/admin/orders') {
      return json(200, (await store.readJSON('orders')).value?.list || []);
    }

    const orderMatch = pathname.match(/^\/api\/admin\/orders\/([a-f0-9]{16})$/);
    if (orderMatch && method === 'PATCH') {
      const { status } = await readJsonBody(req, 1_000);
      if (!STATUSES.includes(status)) throw new HttpError(400, 'Statut invalide.');
      const order = await update('orders', () => ({ nextNo: 1, list: [] }), (doc) => {
        const o = doc.list.find((x) => x.id === orderMatch[1]);
        if (!o) throw new HttpError(404, 'Commande introuvable.');
        o.status = status;
        o.updatedAt = new Date().toISOString();
        return o;
      });
      return json(200, order);
    }

    throw new HttpError(404, 'Introuvable.');
  }

  return async function handle(req, { ip = 'unknown' } = {}) {
    try {
      return await route(req, ip);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: 'Erreur serveur.' });
    }
  };
}
