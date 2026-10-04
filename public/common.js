'use strict';
// Utilitaires partagés boutique / admin. Tout le texte passe par textContent (pas d'injection HTML).

const ICONS = {
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  package: '<path d="M16.5 9.4 7.55 4.24"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
};

function icon(name, size = 20) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  // Contenu SVG statique (constantes ci-dessus), jamais de données utilisateur
  span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

// h('div', { class: 'x', onclick: fn }, 'texte', enfant, ...)
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const euro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
function formatPrice(cents) {
  return euro.format(cents / 100);
}

async function api(url, options = {}) {
  const opts = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
  if (opts.body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw Object.assign(new Error('Connexion impossible. Vérifiez votre réseau.'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Erreur inattendue.'), { status: res.status });
  return data;
}

function imagePlaceholder() {
  return h('div', { class: 'img-placeholder' }, icon('image', 32));
}

let toastTimer;
function toast(message, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ---------- Codes de suivi ----------

const ORDERS_KEY = 'vg-orders';
const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

// Codes des commandes passées depuis ce navigateur (pour les retrouver sans rien taper)
function rememberedCodes() {
  try {
    const list = JSON.parse(localStorage.getItem(ORDERS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((c) => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

function rememberCode(code, keep = true) {
  const list = rememberedCodes().filter((c) => c !== code);
  if (keep) list.unshift(code);
  try {
    localStorage.setItem(ORDERS_KEY, JSON.stringify(list.slice(0, 10)));
  } catch { /* ignoré */ }
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Code copié');
  } catch {
    toast('Copie impossible : notez le code à la main.', 'error');
  }
  button?.focus();
}

function copyButton(code) {
  const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => copyText(formatCode(code), btn) }, icon('copy', 16), 'Copier');
  return btn;
}

// ---------- Nom et description de la boutique (choisis dans l'admin) ----------

const SETTINGS_KEY = 'vg-settings';

function applyShopSettings(settings) {
  if (!settings || !settings.name) return;
  document.querySelectorAll('[data-shop-name]').forEach((el) => { el.textContent = settings.name; });
  document.querySelectorAll('[data-shop-desc]').forEach((el) => {
    el.textContent = settings.description;
    el.hidden = !settings.description;
  });
  const prefix = document.documentElement.dataset.titlePrefix;
  document.title = prefix ? `${prefix} · ${settings.name}` : settings.name;
}

// Affiche tout de suite la dernière valeur connue, puis la met à jour depuis le serveur
function loadShopSettings() {
  try {
    applyShopSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'));
  } catch { /* ignoré */ }
  return api('/api/settings').then((settings) => {
    applyShopSettings(settings);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch { /* ignoré */ }
    return settings;
  }).catch(() => null);
}
