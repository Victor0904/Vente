'use strict';

const STATUS_CLIENT = {
  pending: ['À livrer', 'Commande reçue. Nous vous appelons pour convenir de la livraison.'],
  done: ['Livrée', 'Commande livrée et payée. Merci !'],
  refused: ['Refusée', "Cette commande n'a pas pu être acceptée."],
  cancelled: ['Annulée', 'Cette commande a été annulée.'],
};
const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
const $ = (id) => document.getElementById(id);
let orders = []; // commandes affichées, les plus récentes d'abord

function orderCard(o) {
  const [label, text] = STATUS_CLIENT[o.status] || [o.status, ''];
  return h('article', { class: 'card order' },
    h('div', { class: 'order-head' },
      h('div', {},
        h('h3', {}, `Commande n° ${o.no} · ${formatPrice(o.total)}`),
        h('span', { class: 'meta' }, `Passée le ${dateFmt.format(new Date(o.createdAt))}`)),
      h('span', { class: `status status-${o.status}` }, label)),
    h('p', {}, text),
    h('div', { class: 'order-grid' },
      h('div', { class: 'contact' },
        h('span', { class: 'note' }, 'Livraison'),
        h('strong', {}, o.customer.name),
        h('div', {}, icon('pin', 16), o.customer.address)),
      h('div', { class: 'recap' },
        o.items.map((it) => h('div', { class: 'recap-line' }, h('span', {}, it.title), h('span', {}, formatPrice(it.price)))),
        h('div', { class: 'recap-line total-row' }, h('span', {}, 'À payer sur place'), h('span', {}, formatPrice(o.total))))),
    h('div', { class: 'order-actions' },
      h('span', { class: 'note' }, 'Code ', h('strong', { class: 'code-inline' }, formatCode(o.code))),
      copyButton(o.code),
      h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm',
        onclick: () => { rememberCode(o.code, false); orders = orders.filter((x) => x !== o); render(); },
      }, icon('x', 16), 'Oublier sur cet appareil')));
}

function render() {
  $('mine').hidden = orders.length === 0;
  $('mineList').replaceChildren(...orders.map(orderCard));
}

function showError(message) {
  const input = $('code');
  $('codeError').textContent = message;
  if (message) $('codeError').setAttribute('role', 'alert');
  else $('codeError').removeAttribute('role');
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  input.closest('.field').classList.toggle('invalid', !!message);
}

async function search(e) {
  e.preventDefault();
  const code = $('code').value.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (code.length !== 8) {
    showError('Le code fait 8 caractères (ex. K7P2-9XQ4).');
    $('code').focus();
    return;
  }
  showError('');
  const btn = $('trackBtn');
  btn.disabled = true;
  btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Recherche…');
  try {
    const [order] = await api('/api/track', { method: 'POST', body: { code } });
    rememberCode(order.code);
    orders = [order, ...orders.filter((o) => o.code !== order.code)];
    render();
    $('code').value = '';
    $('mineList').firstChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    showError(err.message);
    $('code').focus();
  } finally {
    btn.disabled = false;
    btn.replaceChildren('Rechercher');
  }
}

// Formate en « XXXX-XXXX » pendant la saisie
$('code').addEventListener('input', (e) => {
  const raw = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
  e.target.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
});
$('trackForm').addEventListener('submit', search);
$('backIcon').append(icon('arrowLeft', 18));
loadShopSettings();

// Recharge automatiquement les commandes passées depuis ce navigateur
const saved = rememberedCodes();
if (saved.length) {
  api('/api/track', { method: 'POST', body: { codes: saved } })
    .then((found) => {
      orders = found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const c of saved) if (!found.some((o) => o.code === c)) rememberCode(c, false); // codes disparus
      render();
    })
    .catch(() => {});
}
