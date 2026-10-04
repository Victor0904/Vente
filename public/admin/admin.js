'use strict';

const STATUS = {
  pending: 'À livrer',
  done: 'Réalisée',
  refused: 'Refusée',
  cancelled: 'Annulée',
};
const STATUS_ORDER = ['pending', 'done', 'refused', 'cancelled'];

const state = {
  tab: 'orders',
  orders: [],
  products: [],
  settings: null,
  filter: 'pending',
  sort: 'oldest',
  search: '',
  busy: new Set(), // ids en cours de mise à jour
};

const app = document.getElementById('app');

function adminApi(url, options = {}) {
  return api(url, { ...options, headers: { 'X-Requested-With': 'admin' } }).catch((err) => {
    if (err.status === 401 && !url.endsWith('/login')) showLogin('Session expirée, reconnectez-vous.');
    throw err;
  });
}

// ---------- Connexion ----------

function showLogin(message = '') {
  clearInterval(refreshTimer);
  let sending = false;
  const err = h('p', { class: 'alert', role: 'alert', hidden: !message }, message);
  const pw = h('input', { id: 'pw', type: 'password', class: 'input', autocomplete: 'current-password', required: true, maxlength: 256 });
  const btn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Se connecter');

  const form = h('form', {
    class: 'card form login-card',
    onsubmit: async (e) => {
      e.preventDefault();
      if (sending || !pw.value) return;
      sending = true;
      btn.disabled = true;
      btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Vérification…');
      try {
        await adminApi('/api/admin/login', { method: 'POST', body: { password: pw.value } });
        startDashboard();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        pw.value = '';
        pw.focus();
        btn.disabled = false;
        btn.replaceChildren('Se connecter');
        sending = false;
      }
    },
  },
  h('h1', {}, 'Espace de gestion'),
  h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Mot de passe'), pw),
  err,
  btn);

  app.replaceChildren(h('main', { class: 'login-wrap' }, form));
  pw.focus();
}

// ---------- Tableau de bord ----------

let refreshTimer;

async function startDashboard() {
  renderShell();
  await Promise.all([loadOrders(), loadProducts(), loadShopSettings().then((st) => { state.settings = st; renderContent(); })]);
  clearInterval(refreshTimer);
  // Rafraîchit les commandes chaque minute (nouvelles commandes)
  refreshTimer = setInterval(() => { if (!document.hidden) loadOrders(); }, 60_000);
}

async function loadOrders() {
  try {
    state.orders = await adminApi('/api/admin/orders');
    renderContent();
  } catch (e) { if (e.status !== 401) toast(e.message, 'error'); }
}

async function loadProducts() {
  try {
    state.products = await adminApi('/api/admin/products');
    renderContent();
  } catch (e) { if (e.status !== 401) toast(e.message, 'error'); }
}

function renderShell() {
  const pendingCount = state.orders.filter((o) => o.status === 'pending').length;
  const tab = (id, label, extra) => h('button', {
    type: 'button', class: 'tab', role: 'tab', 'aria-selected': state.tab === id ? 'true' : 'false',
    onclick: () => { state.tab = id; renderShell(); },
  }, label, extra);

  app.replaceChildren(
    h('header', { class: 'site-header' },
      h('div', { class: 'header-inner' },
        h('div', { class: 'brand' }, h('h1', {}, 'Gestion'), h('small', {}, h('a', { href: '/', target: '_blank', rel: 'noopener' }, 'Voir la boutique'))),
        h('button', {
          type: 'button', class: 'btn btn-ghost btn-sm',
          onclick: async () => { await adminApi('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {}); showLogin(); },
        }, icon('logout', 18), 'Déconnexion'))),
    h('main', { class: 'admin-main' },
      h('div', { class: 'tabs', role: 'tablist' },
        tab('orders', 'Livraisons', pendingCount ? h('span', { class: 'badge' }, pendingCount) : null),
        tab('products', 'Produits', h('span', { class: 'count' }, state.products.length)),
        tab('settings', 'Boutique')),
      h('div', { id: 'content', role: 'tabpanel' })));
  renderContent();
}

function renderContent() {
  const content = document.getElementById('content');
  if (!content) return;
  // Met à jour les compteurs d'onglets sans reconstruire la page
  const tabs = app.querySelectorAll('.tab');
  if (tabs.length) {
    const pending = state.orders.filter((o) => o.status === 'pending').length;
    tabs[0].replaceChildren('Livraisons', pending ? h('span', { class: 'badge' }, pending) : '');
    tabs[1].replaceChildren('Produits', h('span', { class: 'count' }, state.products.length));
  }
  content.replaceChildren(state.tab === 'orders' ? ordersView() : state.tab === 'products' ? productsView() : settingsView());
}

// ---------- Livraisons ----------

function sortedOrders() {
  const q = state.search.trim().toLowerCase();
  let list = state.orders.filter((o) => state.filter === 'all' || o.status === state.filter);
  if (q) {
    const qCode = q.toUpperCase().replace(/[^0-9A-Z]/g, ''); // code de suivi, avec ou sans tiret
    list = list.filter((o) => (qCode.length >= 4 && (o.code || '').includes(qCode)) ||
      [String(o.no), o.customer.name, o.customer.phone, o.customer.address, ...o.items.map((i) => i.title)]
        .some((s) => s.toLowerCase().includes(q)));
  }
  const cmp = {
    oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    total: (a, b) => b.total - a.total,
    name: (a, b) => a.customer.name.localeCompare(b.customer.name, 'fr', { sensitivity: 'base' }),
  }[state.sort];
  return list.sort((a, b) =>
    (state.filter === 'all' ? STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) : 0) || cmp(a, b));
}

function ordersView() {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, state.orders.filter((o) => o.status === s).length]));
  const filterBtn = (id, label, n) => h('button', {
    type: 'button', 'aria-pressed': state.filter === id ? 'true' : 'false',
    onclick: () => { state.filter = id; renderContent(); },
  }, label, h('span', { class: 'count' }, n));

  const sortSelect = h('select', {
    class: 'select', id: 'sort', 'aria-label': 'Trier',
    onchange: (e) => { state.sort = e.target.value; renderContent(); },
  },
  [['oldest', 'Plus anciennes d\'abord'], ['newest', 'Plus récentes d\'abord'], ['total', 'Montant le plus élevé'], ['name', 'Nom (A → Z)']]
    .map(([v, l]) => h('option', { value: v, selected: state.sort === v }, l)));

  const search = h('input', {
    type: 'search', class: 'input', placeholder: 'Nom, téléphone, n°, code…', 'aria-label': 'Rechercher une commande', value: state.search,
    oninput: (e) => {
      state.search = e.target.value;
      const list = document.getElementById('orderList');
      list.replaceChildren(...orderItems());
    },
  });

  return h('div', {},
    h('div', { class: 'toolbar' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Filtrer par statut' },
        filterBtn('pending', 'À livrer', counts.pending),
        filterBtn('done', 'Réalisées', counts.done),
        filterBtn('refused', 'Refusées', counts.refused),
        filterBtn('cancelled', 'Annulées', counts.cancelled),
        filterBtn('all', 'Toutes', state.orders.length)),
      h('div', { class: 'toolbar-group' }, search, sortSelect)),
    h('div', { class: 'list', id: 'orderList', 'aria-live': 'polite' }, orderItems()));
}

function orderItems() {
  const list = sortedOrders();
  if (!list.length) {
    return [h('p', { class: 'empty' }, state.search ? 'Aucune commande ne correspond.' : state.filter === 'pending' ? 'Aucune livraison à effectuer.' : 'Aucune commande ici.')];
  }
  return list.map(orderCard);
}

const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

function orderCard(o) {
  const busy = state.busy.has(o.id);
  const action = (status, label, cls, ic) => h('button', {
    type: 'button', class: `btn btn-sm ${cls}`, disabled: busy, onclick: () => setStatus(o, status),
  }, icon(ic, 16), label);

  const actions = o.status === 'pending'
    ? [action('done', 'Valider : livrée et payée', 'btn-primary', 'check'),
       action('refused', 'Refuser', 'btn-danger', 'x'),
       action('cancelled', 'Annuler', 'btn-ghost', 'x')]
    : [action('pending', 'Remettre à livrer', 'btn-ghost', 'undo')];

  return h('article', { class: `card order${o.status !== 'pending' ? ' is-closed' : ''}` },
    h('div', { class: 'order-head' },
      h('div', {},
        h('h3', {}, `Commande n° ${o.no} · ${formatPrice(o.total)}`),
        h('span', { class: 'meta' }, dateFmt.format(new Date(o.createdAt)),
          o.status !== 'pending' ? ` · traitée le ${dateFmt.format(new Date(o.updatedAt))}` : '',
          o.code ? [' · code ', h('span', { class: 'code-inline' }, formatCode(o.code))] : null)),
      h('span', { class: `status status-${o.status}` }, STATUS[o.status])),
    h('div', { class: 'order-grid' },
      h('div', { class: 'contact' },
        h('strong', {}, o.customer.name),
        h('div', {}, icon('pin', 16), o.customer.address),
        h('div', {}, icon('phone', 16), h('a', { href: `tel:${o.customer.phone.replace(/[^0-9+]/g, '')}` }, o.customer.phone))),
      h('div', { class: 'recap' },
        o.items.map((it) => h('div', { class: 'recap-line' },
          h('span', {}, (it.qty || 1) > 1 ? `${it.qty} × ${it.title}` : it.title), h('span', {}, formatPrice(it.price * (it.qty || 1))))),
        h('div', { class: 'recap-line total-row' }, h('span', {}, 'À encaisser'), h('span', {}, formatPrice(o.total))))),
    h('div', { class: 'order-actions' }, actions));
}

async function setStatus(o, status) {
  state.busy.add(o.id);
  renderContent();
  try {
    const updated = await adminApi(`/api/admin/orders/${o.id}`, { method: 'PATCH', body: { status } });
    Object.assign(o, updated);
    toast(`Commande n° ${o.no} : ${STATUS[status].toLowerCase()}`);
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  } finally {
    state.busy.delete(o.id);
    renderContent();
  }
}

// ---------- Nom et description de la boutique ----------

function settingsView() {
  if (!state.settings) return h('p', { class: 'empty' }, 'Chargement…');
  const name = h('input', { id: 'set-name', class: 'input', type: 'text', maxlength: 60, required: true, value: state.settings.name });
  const desc = h('input', { id: 'set-desc', class: 'input', type: 'text', maxlength: 160, value: state.settings.description });
  const error = h('div', { class: 'alert', role: 'alert', hidden: true });
  const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Enregistrer');

  return h('form', {
    class: 'card form settings-card', novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      if (!name.value.trim()) {
        error.textContent = 'Le nom est obligatoire.';
        error.hidden = false;
        name.focus();
        return;
      }
      error.hidden = true;
      btn.disabled = true;
      btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Enregistrement…');
      try {
        state.settings = await adminApi('/api/admin/settings', { method: 'PUT', body: { name: name.value, description: desc.value } });
        applyShopSettings(state.settings);
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* ignoré */ }
        toast('Boutique mise à jour');
      } catch (err) {
        if (err.status !== 401) {
          error.textContent = err.message;
          error.hidden = false;
        }
      } finally {
        btn.disabled = false;
        btn.replaceChildren('Enregistrer');
      }
    },
  },
  h('h2', {}, 'Votre boutique'),
  h('div', { class: 'field' }, h('label', { for: 'set-name' }, 'Nom'), name, h('span', { class: 'hint' }, "Affiché en haut de la boutique et dans l'onglet du navigateur.")),
  h('div', { class: 'field' }, h('label', { for: 'set-desc' }, 'Description'), desc, h('span', { class: 'hint' }, 'Une courte phrase sous le nom (facultatif).')),
  error,
  h('div', { class: 'modal-foot' }, btn));
}

// ---------- Produits ----------

function productsView() {
  const list = h('div', { class: 'list' });
  if (!state.products.length) list.append(h('p', { class: 'empty' }, 'Aucun produit. Ajoutez-en un.'));
  for (const p of state.products) {
    list.append(h('article', { class: 'card prod-row' },
      h('div', { class: 'mini' }, p.images[0] ? h('img', { src: p.images[0], alt: '' }) : imagePlaceholder()),
      h('div', { class: 'prod-info' },
        h('div', { class: 'line-title' }, p.title),
        h('div', { class: 'line-sub' }, h('strong', {}, formatPrice(p.price)))),
      h('div', { class: 'prod-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => openProductForm(p) }, icon('edit', 16), 'Modifier'),
        deleteButton(p))));
  }
  return h('div', {},
    h('div', { class: 'toolbar' },
      h('p', { class: 'note' }, 'Une annonce reste en ligne tant que vous ne la supprimez pas.'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openProductForm(null) }, icon('plus', 18), 'Ajouter un produit')),
    list);
}

// Suppression en deux clics (pas de boîte de dialogue native)
function deleteButton(p) {
  let timer;
  const btn = h('button', {
    type: 'button', class: 'btn btn-danger btn-sm', 'aria-label': `Supprimer ${p.title}`,
    onclick: async () => {
      if (!btn.classList.contains('confirming')) {
        btn.classList.add('confirming');
        btn.replaceChildren(icon('trash', 16), 'Confirmer ?');
        timer = setTimeout(() => { btn.classList.remove('confirming'); btn.replaceChildren(icon('trash', 16), 'Supprimer'); }, 3000);
        return;
      }
      clearTimeout(timer);
      btn.disabled = true;
      try {
        await adminApi(`/api/admin/products/${p.id}`, { method: 'DELETE' });
        state.products = state.products.filter((x) => x !== p);
        toast(`« ${p.title} » supprimé`);
        renderContent();
      } catch (e) {
        if (e.status !== 401) toast(e.message, 'error');
        btn.disabled = false;
      }
    },
  }, icon('trash', 16), 'Supprimer');
  return btn;
}

// Redimensionne (1600 px max) et réencode en JPEG : fichiers légers, métadonnées (GPS…) supprimées
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

function openProductForm(product) {
  const isNew = !product;
  const data = {
    title: product?.title || '',
    description: product?.description || '',
    price: product ? String(product.price / 100).replace('.', ',') : '',
    images: [...(product?.images || [])],
  };
  let uploading = 0;
  let saving = false;
  let saved = false;
  const uploadedNow = []; // photos envoyées pendant ce formulaire

  const dialog = h('dialog', { class: 'modal', 'aria-labelledby': 'pf-heading' });
  const errorBox = h('div', { class: 'alert', role: 'alert', hidden: true });
  const imgGrid = h('div', { class: 'img-editor' });
  const fileInput = h('input', {
    type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,image/*', multiple: true, class: 'sr-only', id: 'pf-files',
    onchange: async (e) => {
      const files = [...e.target.files].slice(0, 10 - data.images.length);
      e.target.value = '';
      for (const file of files) {
        uploading++;
        renderImages();
        try {
          const dataUrl = await prepareImage(file);
          const { url } = await adminApi('/api/admin/upload', { method: 'POST', body: { data: dataUrl } });
          data.images.push(url);
          uploadedNow.push(url);
        } catch (err) {
          toast(err.status ? err.message : `Image illisible : ${file.name}`, 'error');
        } finally {
          uploading--;
          renderImages();
        }
      }
    },
  });

  function renderImages() {
    imgGrid.replaceChildren(
      ...data.images.map((url, i) => h('div', { class: `img-tile${i === 0 ? ' main' : ''}` },
        h('img', { src: url, alt: `Photo ${i + 1}` }),
        i === 0 ? h('span', { class: 'tag' }, 'Principale') : null,
        h('div', { class: 'tile-actions' },
          i > 0
            ? h('button', { type: 'button', class: 'icon-btn', title: 'Mettre en photo principale', 'aria-label': `Mettre la photo ${i + 1} en principale`,
                onclick: () => { data.images.unshift(...data.images.splice(i, 1)); renderImages(); } }, icon('star', 16))
            : h('span'),
          h('button', { type: 'button', class: 'icon-btn', title: 'Retirer', 'aria-label': `Retirer la photo ${i + 1}`,
            onclick: () => { data.images.splice(i, 1); renderImages(); } }, icon('trash', 16))))),
      ...Array.from({ length: uploading }, () => h('div', { class: 'img-tile loading' }, h('span', { class: 'spinner', 'aria-label': 'Envoi en cours' }))),
      data.images.length + uploading < 10
        ? h('label', { class: 'img-add', for: 'pf-files' }, icon('plus', 22), 'Ajouter')
        : null);
    saveBtn.disabled = uploading > 0 || saving;
  }

  const field = (key, label, input, hint) => {
    input.id = `pf-${key}`;
    input.value = data[key];
    input.addEventListener('input', () => { data[key] = input.value; });
    return h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
  };

  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, isNew ? 'Ajouter' : 'Enregistrer');
  const form = h('form', {
    class: 'form modal-body', novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      const price = Number(data.price.replace(/\s/g, '').replace(',', '.'));
      const problems = [];
      if (!data.title.trim()) problems.push('Le titre est obligatoire.');
      if (data.price.trim() === '' || !Number.isFinite(price) || price < 0) problems.push('Prix invalide (ex. 12,50).');
      if (problems.length) {
        errorBox.textContent = problems.join(' ');
        errorBox.hidden = false;
        return;
      }
      saving = true;
      saveBtn.disabled = true;
      saveBtn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Enregistrement…');
      try {
        const body = { title: data.title, description: data.description, price, images: data.images };
        if (isNew) await adminApi('/api/admin/products', { method: 'POST', body });
        else await adminApi(`/api/admin/products/${product.id}`, { method: 'PUT', body });
        toast(isNew ? 'Produit ajouté' : 'Produit mis à jour');
        saved = true;
        dialog.close();
        loadProducts();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
        saving = false;
        saveBtn.disabled = false;
        saveBtn.replaceChildren(isNew ? 'Ajouter' : 'Enregistrer');
      }
    },
  },
  field('title', 'Titre', h('input', { class: 'input', type: 'text', maxlength: 120, required: true })),
  field('description', 'Description', h('textarea', { class: 'textarea', maxlength: 2000, rows: 4 }), 'État, dimensions, défauts éventuels.'),
  field('price', 'Prix (€)', h('input', { class: 'input', type: 'text', inputmode: 'decimal', required: true, placeholder: '0,00' })),
  h('div', { class: 'field' },
    h('span', { class: 'label' }, 'Photos'),
    h('span', { class: 'hint' }, 'La première est la photo principale. 10 maximum.'),
    imgGrid, fileInput),
  errorBox,
  h('div', { class: 'modal-foot' },
    h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => dialog.close() }, 'Annuler'),
    saveBtn));

  dialog.append(
    h('div', { class: 'modal-head' },
      h('h2', { id: 'pf-heading' }, isNew ? 'Nouveau produit' : 'Modifier le produit'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => dialog.close() }, icon('x'))),
    form);
  dialog.addEventListener('close', () => {
    dialog.remove();
    // Formulaire annulé : on supprime les photos envoyées pour rien
    if (!saved) {
      for (const url of uploadedNow) {
        adminApi(`/api/admin/upload/${url.split('/').pop()}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  });
  document.body.append(dialog);
  renderImages();
  dialog.showModal();
  document.getElementById('pf-title').focus();
}

// ---------- Démarrage ----------

api('/api/admin/me').then(startDashboard).catch((e) => showLogin(e.status === 401 ? '' : e.message));
