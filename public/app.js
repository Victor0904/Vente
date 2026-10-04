'use strict';

const CART_KEY = 'vg-cart';
const state = {
  products: [],
  cart: new Set(), // ids des annonces (objets uniques)
  step: 'cart', // cart | checkout | done
  draft: { name: '', address: '', phone: '', pay: false },
  errors: {},
  formError: '',
  sending: false,
  lastOrder: null,
};
const imageIndex = new Map(); // id produit -> image affichée

const $ = (id) => document.getElementById(id);

// ---------- Panier (persisté dans le navigateur) ----------

function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string') state.cart.add(id);
  } catch { /* stockage indisponible : panier vide */ }
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify([...state.cart]));
  } catch { /* ignoré */ }
}

// Retire du panier les annonces supprimées entre-temps
function reconcileCart() {
  let changed = false;
  for (const id of state.cart) {
    if (!productById(id)) { state.cart.delete(id); changed = true; }
  }
  if (changed) saveCart();
  return changed;
}

const productById = (id) => state.products.find((p) => p.id === id);

const cartItems = () => [...state.cart].map(productById).filter(Boolean);
const cartTotal = () => cartItems().reduce((sum, p) => sum + p.price, 0);

function setInCart(id, inCart) {
  if (inCart) state.cart.add(id);
  else state.cart.delete(id);
  saveCart();
  if (state.step === 'done') state.step = 'cart';
  if (state.cart.size === 0 && state.step === 'checkout') state.step = 'cart';
  render();
}

// ---------- Catalogue ----------

function renderCatalog() {
  const root = $('catalog');
  root.setAttribute('aria-busy', 'false');
  root.replaceChildren();
  if (!state.products.length) {
    root.append(h('p', { class: 'empty' }, 'Aucun objet en vente pour le moment. Revenez bientôt !'));
    return;
  }
  for (const p of state.products) root.append(productCard(p));
}

function productCard(p) {
  const idx = Math.min(imageIndex.get(p.id) || 0, Math.max(0, p.images.length - 1));
  const inCart = state.cart.has(p.id);

  const media = h('div', { class: 'product-media' },
    p.images.length
      ? h('img', { src: p.images[idx], alt: p.title, loading: 'lazy', decoding: 'async', width: 400, height: 300 })
      : imagePlaceholder());

  const thumbs = p.images.length > 1
    ? h('div', { class: 'thumbs' }, p.images.map((src, i) =>
        h('button', {
          type: 'button', class: 'thumb', 'aria-label': `Photo ${i + 1} sur ${p.images.length}`,
          'aria-current': i === idx ? 'true' : 'false',
          onclick: () => { imageIndex.set(p.id, i); renderCatalog(); },
        }, h('img', { src, alt: '', loading: 'lazy' }))))
    : null;

  const addBtn = inCart
    ? h('button', { type: 'button', class: 'btn btn-added btn-sm', onclick: openCart }, icon('check', 18), 'Dans le panier')
    : h('button', {
        type: 'button', class: 'btn btn-primary btn-sm',
        onclick: () => { setInCart(p.id, true); toast(`« ${p.title} » ajouté au panier`); },
      }, icon('plus', 18), 'Ajouter');

  return h('article', { class: 'card' },
    media,
    thumbs,
    h('div', { class: 'product-body' },
      h('h3', {}, p.title),
      p.description ? h('p', { class: 'product-desc' }, p.description) : null,
      h('div', { class: 'product-foot' }, h('span', { class: 'price' }, formatPrice(p.price)), addBtn)));
}

// ---------- Panier / commande ----------

function renderCart() {
  const body = $('cartBody');
  const foot = $('cartFoot');
  body.replaceChildren();
  foot.replaceChildren();
  $('cartTitle').textContent = state.step === 'checkout' ? 'Livraison' : state.step === 'done' ? 'Commande envoyée' : 'Votre panier';

  if (state.step === 'done') return renderDone(body);
  const items = cartItems();
  if (!items.length) {
    body.append(h('p', { class: 'empty' }, 'Votre panier est vide.'));
    return;
  }
  if (state.step === 'checkout') return renderCheckout(body, foot, items);

  for (const p of items) {
    body.append(h('div', { class: 'cart-line' },
      h('div', { class: 'mini' }, p.images[0] ? h('img', { src: p.images[0], alt: '' }) : imagePlaceholder()),
      h('div', {},
        h('div', { class: 'line-title' }, p.title),
        h('div', { class: 'line-sub' }, formatPrice(p.price))),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Retirer ${p.title} du panier`, onclick: () => setInCart(p.id, false) }, icon('trash', 16))));
  }

  foot.append(
    h('div', { class: 'total-row' }, h('span', {}, 'Total'), h('span', { class: 'price' }, formatPrice(cartTotal()))),
    h('p', { class: 'note' }, 'Paiement sur place, à la livraison.'),
    h('button', { type: 'button', class: 'btn btn-accent btn-block', onclick: () => { state.step = 'checkout'; render(); focusFirstField(); } }, 'Commander'));
}

const FIELDS = {
  name: { label: 'Nom', check: (v) => (v.trim().length >= 2 ? '' : 'Indiquez votre nom.') },
  address: { label: 'Adresse / lieu de livraison', check: (v) => (v.trim().length >= 5 ? '' : 'Indiquez où livrer.') },
  phone: {
    label: 'Téléphone',
    check: (v) => (/^\+?[0-9][0-9 .\-()]{6,18}[0-9]$/.test(v.trim()) ? '' : 'Numéro invalide (ex. 06 12 34 56 78).'),
  },
};

function validateField(key) {
  state.errors[key] = key === 'pay'
    ? (state.draft.pay ? '' : 'Cochez cette case pour confirmer.')
    : FIELDS[key].check(state.draft[key]);
  return !state.errors[key];
}

function fieldError(key) {
  return h('p', { class: 'field-error', id: `err-${key}`, role: state.errors[key] ? 'alert' : null }, state.errors[key] || '');
}

function textField(key, attrs) {
  const isArea = key === 'address';
  const input = h(isArea ? 'textarea' : 'input', {
    id: `f-${key}`, name: key, class: isArea ? 'textarea' : 'input', required: true,
    'aria-invalid': state.errors[key] ? 'true' : 'false', 'aria-describedby': `err-${key}`,
    ...attrs,
    oninput: (e) => { state.draft[key] = e.target.value; },
    onblur: (e) => {
      if (!e.target.value && !state.errors[key]) return; // ne pas crier sur un champ pas encore rempli
      validateField(key);
      const wrap = e.target.closest('.field');
      wrap.classList.toggle('invalid', !!state.errors[key]);
      e.target.setAttribute('aria-invalid', state.errors[key] ? 'true' : 'false');
      wrap.querySelector('.field-error').textContent = state.errors[key] || '';
    },
  });
  input.value = state.draft[key];
  return h('div', { class: `field${state.errors[key] ? ' invalid' : ''}` },
    h('label', { for: `f-${key}` }, FIELDS[key].label),
    input,
    fieldError(key));
}

function renderCheckout(body, foot, items) {
  const recap = h('div', { class: 'recap', 'aria-label': 'Récapitulatif' },
    items.map((p) => h('div', { class: 'recap-line' }, h('span', {}, p.title), h('span', {}, formatPrice(p.price)))),
    h('div', { class: 'recap-line total-row' }, h('span', {}, 'Total à payer sur place'), h('span', {}, formatPrice(cartTotal()))));

  const form = h('form', { class: 'form', id: 'checkoutForm', novalidate: true, onsubmit: submitOrder },
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { state.step = 'cart'; state.formError = ''; render(); } },
      icon('arrowLeft', 16), 'Modifier le panier'),
    recap,
    textField('name', { type: 'text', autocomplete: 'name', maxlength: 80 }),
    textField('address', { autocomplete: 'street-address', maxlength: 300, rows: 3 }),
    textField('phone', { type: 'tel', autocomplete: 'tel', inputmode: 'tel', maxlength: 20 }),
    h('div', { class: 'field' },
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', id: 'f-pay', checked: state.draft.pay, 'aria-describedby': 'err-pay',
          onchange: (e) => { state.draft.pay = e.target.checked; if (e.target.checked) { state.errors.pay = ''; e.target.closest('.field').querySelector('.field-error').textContent = ''; } },
        }),
        h('span', {}, 'Je m\'engage à payer ', h('strong', {}, formatPrice(cartTotal())), ' sur place, à la livraison.')),
      fieldError('pay')),
    state.formError ? h('div', { class: 'alert', role: 'alert' }, state.formError) : null);
  body.append(form);

  foot.append(h('button', { type: 'submit', form: 'checkoutForm', class: 'btn btn-accent btn-block', disabled: state.sending },
    state.sending ? [h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Envoi…'] : `Confirmer la commande · ${formatPrice(cartTotal())}`));
}

function focusFirstField() {
  requestAnimationFrame(() => $('f-name')?.focus());
}

async function submitOrder(e) {
  e.preventDefault();
  if (state.sending) return;
  const keys = ['name', 'address', 'phone', 'pay'];
  const ok = keys.map(validateField).every(Boolean);
  state.formError = '';
  if (!ok) {
    render();
    $(`f-${keys.find((k) => state.errors[k])}`)?.focus();
    return;
  }
  state.sending = true;
  render();
  try {
    const res = await api('/api/orders', {
      method: 'POST',
      body: {
        name: state.draft.name, address: state.draft.address, phone: state.draft.phone, payOnDelivery: true,
        items: [...state.cart],
      },
    });
    state.lastOrder = { ...res, phone: state.draft.phone.trim() };
    rememberCode(res.code);
    state.cart.clear();
    saveCart();
    state.draft = { name: '', address: '', phone: '', pay: false };
    state.step = 'done';
    loadProducts();
  } catch (err) {
    state.formError = err.message;
    if (err.status === 409) await loadProducts();
  } finally {
    state.sending = false;
    render();
  }
}

function renderDone(body) {
  const o = state.lastOrder;
  body.append(h('div', { class: 'success', role: 'status' },
    h('div', { class: 'ok-icon' }, icon('check', 28)),
    h('h3', {}, `Commande n° ${o.no} enregistrée`),
    h('div', { class: 'code-box' },
      h('span', { class: 'code-label' }, 'Votre code de suivi'),
      h('strong', { class: 'code' }, formatCode(o.code)),
      copyButton(o.code),
      h('span', { class: 'note' }, 'Gardez-le : il permet de suivre votre commande sur la page ', h('a', { href: '/suivi/' }, 'Suivre ma commande'), '.')),
    h('p', {}, 'Nous vous contacterons au ', h('strong', {}, o.phone), ' pour convenir de la livraison.'),
    h('p', {}, 'À payer sur place : ', h('strong', {}, formatPrice(o.total))),
    h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { state.step = 'cart'; closeCart(); render(); } }, 'Continuer mes achats')));
}

// ---------- Panneau mobile ----------

function openCart() {
  document.body.classList.add('cart-open');
  $('cartToggle').setAttribute('aria-expanded', 'true');
  if (window.matchMedia('(max-width: 1023px)').matches) $('cartClose').focus();
}
function closeCart() {
  document.body.classList.remove('cart-open');
  $('cartToggle').setAttribute('aria-expanded', 'false');
}

function renderBadges() {
  const n = state.cart.size;
  const badge = $('cartBadge');
  badge.hidden = n === 0;
  badge.textContent = n;
  const fab = $('cartFab');
  fab.hidden = n === 0 || state.step === 'done';
  fab.replaceChildren(h('span', {}, `Voir le panier (${n})`), h('span', {}, formatPrice(cartTotal())));
}

function render() {
  renderCatalog();
  renderCart();
  renderBadges();
}

async function loadProducts() {
  try {
    state.products = await api('/api/products');
    if (reconcileCart() && state.step !== 'done') toast('Un article de votre panier n\'est plus en vente.', 'error');
  } catch (err) {
    $('catalog').replaceChildren(h('div', { class: 'empty' },
      h('p', {}, err.message),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: loadProducts }, 'Réessayer')));
    return;
  }
  render();
}

$('cartToggleIcon').append(icon('cart'));
$('cartClose').append(icon('x'));
$('cartToggle').addEventListener('click', () => {
  if (window.matchMedia('(min-width: 1024px)').matches) $('cart').scrollIntoView({ behavior: 'smooth' });
  else openCart();
});
$('cartClose').addEventListener('click', closeCart);
$('overlay').addEventListener('click', closeCart);
$('cartFab').addEventListener('click', openCart);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCart(); });

loadCart();
loadShopSettings();
loadProducts();
