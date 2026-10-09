/* Fruit store: stock and prices (NPR), buying, and the buyer's own orders.
   A fruit is only buyable when the server says stock > 0 and a price is set; the server re-checks every order. */
(function () {
  'use strict';
  const BH = window.BH, h = BH.h;
  const el = {
    q: BH.$('#s-q'), category: BH.$('#s-category'), instock: BH.$('#s-instock'), form: BH.$('#s-filters'),
    count: BH.$('#s-count'), grid: BH.$('#s-grid'), payNote: BH.$('#pay-note'),
    ordersSection: BH.$('#orders-section'), orders: BH.$('#orders-list'),
    dialog: BH.$('#buy-dialog'), buyForm: BH.$('#buy-form'), body: BH.$('#buy-form-body'), result: BH.$('#buy-result'),
    title: BH.$('#buy-title'), summary: BH.$('#buy-summary'), qty: BH.$('#buy-qty'), max: BH.$('#buy-max'),
    roblox: BH.$('#buy-roblox'), note: BH.$('#buy-note'), total: BH.$('#buy-total'), error: BH.$('#buy-error'), submit: BH.$('#buy-submit')
  };
  let metaLoaded = false;
  let buying = null;
  let robloxName = null;

  el.q.value = new URLSearchParams(location.search).get('q') || '';

  function card(it) {
    let button;
    if (it.available) button = h('button', { class: 'btn', type: 'button', text: 'BUY NOW', onclick: () => openBuy(it) });
    else button = h('button', { class: 'btn ghost', type: 'button', disabled: true, text: it.stock > 0 ? 'UNAVAILABLE' : 'OUT OF STOCK' });
    return h('article', { class: 'card store-card' + (it.available ? '' : ' closed') },
      h('div', { class: 'store-top' }, BH.itemBadge(it, 'lg'),
        h('div', {}, h('h3', { text: it.name }), h('span', { class: 'pill ' + BH.rarityClass(it.rarity), text: it.rarity }),
          it.baseFruit ? h('div', {}, h('small', { class: 'muted', text: 'Skin of ' + it.baseFruit })) : null)),
      it.priceNpr > 0 ? h('div', { class: 'price', text: BH.fmtNpr(it.priceNpr) }) : h('div', { class: 'price unset', text: 'Price not set' }),
      it.stock > 0 ? h('div', { class: 'stock-line in', text: it.stock + ' in stock' }) : h('div', { class: 'stock-line out', text: 'OUT OF STOCK' }),
      button);
  }

  async function load() {
    const query = new URLSearchParams();
    if (el.q.value.trim()) query.set('q', el.q.value.trim());
    if (el.category.value) query.set('category', el.category.value);
    try {
      const d = await BH.api('/store?' + query);
      if (!metaLoaded) {
        d.categories.forEach((c) => el.category.append(h('option', { value: c, text: c })));
        metaLoaded = true;
        el.payNote.hidden = false;
        el.payNote.textContent = d.payment.provider === 'test'
          ? 'Test mode: payments are simulated and no real money is taken. A live Nepal payment provider can be connected later.'
          : 'Payment: ' + d.payment.label + '.';
      }
      const list = el.instock.checked ? d.items.filter((i) => i.available) : d.items;
      BH.clear(el.grid);
      el.count.textContent = list.length + (list.length === 1 ? ' item' : ' items') + ' \u00B7 ' + d.items.filter((i) => i.available).length + ' in stock';
      if (!list.length) { el.grid.append(h('div', { class: 'empty-state' }, h('h3', { text: el.instock.checked ? 'Nothing is in stock right now' : 'No items match' }), h('p', { text: 'Check back soon, or clear the filters.' }))); return; }
      list.forEach((it) => el.grid.append(card(it)));
    } catch (e) { BH.clear(el.grid); el.grid.append(h('div', { class: 'empty-box', text: e.message })); }
  }

  /* ---------- Buying ---------- */
  const updateTotal = () => { const n = Number(el.qty.value); el.total.textContent = BH.fmtNpr(Number.isInteger(n) && n > 0 && buying ? n * buying.priceNpr : 0); };
  el.qty.addEventListener('input', updateTotal);

  async function openBuy(it) {
    if (!BH.me) { location.href = '/login.html?next=' + encodeURIComponent('/store.html'); return; }
    buying = it;
    el.title.textContent = 'Buy ' + it.name;
    BH.clear(el.summary).append(BH.itemBadge(it), h('div', {}, h('b', { text: it.name }), h('div', { class: 'muted', text: BH.fmtNpr(it.priceNpr) + ' each \u00B7 ' + it.stock + ' in stock' })));
    el.qty.max = String(it.stock); el.qty.value = '1'; el.max.textContent = 'Up to ' + it.stock;
    el.note.value = ''; el.error.textContent = ''; el.submit.disabled = false;
    el.body.hidden = false; el.result.hidden = true;
    updateTotal();
    if (robloxName === null) {
      robloxName = '';
      try { const p = await BH.api('/profile/me'); robloxName = (p.profile.roblox && p.profile.roblox.username) || ''; } catch (e) { /* optional */ }
    }
    if (!el.roblox.value) el.roblox.value = robloxName;
    el.dialog.showModal();
    el.qty.focus();
  }
  BH.$('#buy-close').addEventListener('click', () => el.dialog.close());

  el.buyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!buying) return;
    el.error.textContent = '';
    const qty = Number(el.qty.value);
    if (!Number.isInteger(qty) || qty < 1) { el.error.textContent = 'Quantity must be a whole number, 1 or more.'; return; }
    if (qty > buying.stock) { el.error.textContent = 'Only ' + buying.stock + ' in stock.'; return; }
    el.submit.disabled = true;
    try {
      const d = await BH.api('/store/orders', { method: 'POST', body: { itemId: buying.id, qty, robloxUsername: el.roblox.value.trim(), note: el.note.value } });
      showResult(d);
      load(); loadOrders();
    } catch (err) {
      el.error.textContent = err.message;
      el.submit.disabled = false;
      if (err.status === 409) load(); // stock changed under us: refresh the shelf
    }
  });

  function showResult(d) {
    const o = d.order;
    el.title.textContent = 'Order placed';
    el.body.hidden = true;
    BH.clear(el.result).append(
      h('p', {}, h('b', { text: 'Order #' + o.id }), ' \u00B7 ' + o.qty + ' \u00D7 ' + o.itemName + ' \u00B7 ' + BH.fmtNpr(o.totalNpr)),
      h('p', { class: 'callout', text: d.payment.instructions }),
      h('p', { class: 'muted', text: 'Payment reference: ' + o.paymentRef + '. We will deliver to the Roblox user "' + o.robloxUsername + '".' }),
      h('div', { class: 'dialog-actions' },
        d.payment.canSimulate ? h('button', { class: 'btn', type: 'button', text: 'Simulate payment (test mode)', onclick: async (ev) => {
          ev.target.disabled = true;
          try { await BH.api('/store/orders/' + o.id + '/pay-test', { method: 'POST' }); BH.toast('Test payment recorded.'); el.dialog.close(); loadOrders(); }
          catch (err) { BH.toast(err.message, 'error'); ev.target.disabled = false; }
        } }) : null,
        h('button', { class: 'btn ghost', type: 'button', text: 'Close', onclick: () => el.dialog.close() })));
    el.result.hidden = false;
  }

  /* ---------- My orders ---------- */
  async function loadOrders() {
    if (!BH.me) return;
    try {
      const d = await BH.api('/store/orders');
      el.ordersSection.hidden = !d.orders.length;
      BH.clear(el.orders);
      d.orders.forEach((o) => el.orders.append(h('article', { class: 'card order-row' },
        h('div', { class: 'row-head' },
          h('b', { text: '#' + o.id + ' \u00B7 ' + o.qty + ' \u00D7 ' + o.itemName }),
          h('span', { class: 'status-pill s-' + o.status, text: o.status })),
        h('div', { class: 'muted', text: BH.fmtNpr(o.totalNpr) + ' \u00B7 ' + BH.ago(o.createdAt) + ' \u00B7 ref ' + o.paymentRef + ' \u00B7 deliver to ' + o.robloxUsername }),
        o.status === 'pending' ? h('div', { class: 'row-actions' },
          d.canSimulate ? h('button', { class: 'btn small', type: 'button', text: 'Simulate payment', onclick: async () => {
            try { await BH.api('/store/orders/' + o.id + '/pay-test', { method: 'POST' }); BH.toast('Test payment recorded.'); loadOrders(); } catch (err) { BH.toast(err.message, 'error'); }
          } }) : null,
          h('button', { class: 'btn danger small', type: 'button', text: 'Cancel order', onclick: async () => {
            if (!confirm('Cancel this order? The fruit goes back on sale.')) return;
            try { await BH.api('/store/orders/' + o.id + '/cancel', { method: 'POST' }); BH.toast('Order cancelled.'); loadOrders(); load(); } catch (err) { BH.toast(err.message, 'error'); }
          } })) : null)));
    } catch (e) { /* not critical */ }
  }

  el.form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  el.q.addEventListener('input', BH.debounce(load, 250));
  el.category.addEventListener('change', load);
  el.instock.addEventListener('change', load);
  BH.ready.then(() => { load(); loadOrders(); });
})();
