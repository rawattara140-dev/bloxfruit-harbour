/* Values page: search, filter, sort, quick-add to trade, and admin editing. */
(function () {
  'use strict';
  const BH = window.BH, h = BH.h;
  const els = {
    q: BH.$('#f-q'), category: BH.$('#f-category'), rarity: BH.$('#f-rarity'), sort: BH.$('#f-sort'),
    reset: BH.$('#f-reset'), count: BH.$('#count'), grid: BH.$('#grid'), form: BH.$('#filters'),
    adminBar: BH.$('#admin-bar'), add: BH.$('#add-item'),
    dialog: BH.$('#item-dialog'), itemForm: BH.$('#item-form'), error: BH.$('#item-error'), del: BH.$('#item-delete'), title: BH.$('#item-dialog-title')
  };
  let metaLoaded = false;
  let editingId = null;
  let isAdmin = false;

  // Initial filters from the URL (the home page search links here with ?q=...)
  const params = new URLSearchParams(location.search);
  els.q.value = params.get('q') || '';
  const initial = { category: params.get('category') || '', rarity: params.get('rarity') || '', sort: params.get('sort') || 'value_desc' };
  if ([...els.sort.options].some((o) => o.value === initial.sort)) els.sort.value = initial.sort;

  function fillSelect(select, values, selected) {
    values.forEach((v) => select.append(h('option', { value: v, text: v })));
    if (values.includes(selected)) select.value = selected;
  }

  function addToDraft(item, side) {
    const d = BH.draft.load();
    const list = d[side];
    const found = list.find((e) => e.id === item.id);
    if (found) found.qty = Math.min(99, found.qty + 1); else list.push({ id: item.id, qty: 1 });
    BH.draft.save(d);
    BH.toast(item.name + ' added to ' + (side === 'give' ? 'You give' : 'You get') + ' on the Trading page.');
  }

  function renderCard(it) {
    const actions = h('div', { class: 'item-actions' },
      h('button', { class: 'btn ghost small', type: 'button', text: 'Give', 'aria-label': 'Add ' + it.name + ' to You give', onclick: () => addToDraft(it, 'give') }),
      h('button', { class: 'btn secondary small', type: 'button', text: 'Get', 'aria-label': 'Add ' + it.name + ' to You get', onclick: () => addToDraft(it, 'get') }),
      isAdmin ? h('button', { class: 'btn small', type: 'button', text: 'Edit', onclick: () => openEditor(it) }) : null);
    const extra = h('div', { class: 'item-card-extra', style: null },
      h('div', { class: 'item-extra', text: (it.baseFruit ? 'Skin of ' + it.baseFruit + ' \u00B7 ' : it.type ? it.type + ' \u00B7 ' : '') + BH.fmtBeli(it.priceBeli) }),
      it.notes ? h('div', { class: 'item-extra', text: it.notes }) : null,
      h('div', { class: 'item-extra', text: 'Updated ' + BH.fmtDate(it.updatedAt) }),
      actions);
    const card = BH.itemCard(it, extra);
    return card;
  }

  async function load() {
    const query = new URLSearchParams();
    if (els.q.value.trim()) query.set('q', els.q.value.trim());
    if (els.category.value) query.set('category', els.category.value);
    if (els.rarity.value) query.set('rarity', els.rarity.value);
    query.set('sort', els.sort.value);
    history.replaceState(null, '', '?' + query.toString());
    try {
      const d = await BH.api('/values?' + query.toString());
      if (!metaLoaded) {
        fillSelect(els.category, d.categories, initial.category);
        fillSelect(els.rarity, d.rarities, initial.rarity);
        metaLoaded = true;
        if ((initial.category && els.category.value) || (initial.rarity && els.rarity.value)) return load();
      }
      BH.clear(els.grid);
      els.count.textContent = d.items.length + (d.items.length === 1 ? ' item' : ' items');
      if (!d.items.length) {
        els.grid.append(h('div', { class: 'empty-state', style: null },
          h('h3', { text: 'No items match your filters' }),
          h('p', { text: 'Try a different search, or reset the filters.' }),
          h('button', { class: 'btn ghost', type: 'button', text: 'Reset filters', onclick: resetFilters })));
        return;
      }
      d.items.forEach((it) => els.grid.append(renderCard(it)));
    } catch (e) {
      BH.clear(els.grid);
      els.grid.append(h('div', { class: 'empty-box', text: e.message }));
    }
  }

  function resetFilters() {
    els.q.value = ''; els.category.value = ''; els.rarity.value = ''; els.sort.value = 'value_desc';
    load();
  }

  els.form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  els.q.addEventListener('input', BH.debounce(load, 250));
  [els.category, els.rarity, els.sort].forEach((s) => s.addEventListener('change', load));
  els.reset.addEventListener('click', resetFilters);

  /* ---------- Admin editor ---------- */
  const f = (id) => BH.$('#i-' + id);
  function openEditor(it) {
    editingId = it ? it.id : null;
    els.title.textContent = it ? 'Edit ' + it.name : 'Add item';
    els.error.textContent = '';
    els.del.hidden = !it;
    f('name').value = it ? it.name : '';
    f('category').value = it ? it.category : 'Fruit';
    f('type').value = it ? it.type : '';
    f('rarity').value = it ? it.rarity : 'Common';
    f('value').value = it ? it.value : '';
    f('demand').value = it ? it.demand : 5;
    f('trend').value = it ? it.trend : 'stable';
    f('base').value = it ? it.baseFruit : '';
    f('price').value = it && it.priceBeli !== null ? it.priceBeli : '';
    f('notes').value = it ? it.notes : '';
    f('image').value = it ? it.imageUrl : '';
    els.dialog.showModal();
    f('name').focus();
  }
  const closeEditor = () => els.dialog.close();
  BH.$('#item-close').addEventListener('click', closeEditor);
  BH.$('#item-cancel').addEventListener('click', closeEditor);
  els.add.addEventListener('click', () => openEditor(null));

  els.itemForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    els.error.textContent = '';
    const body = {
      name: f('name').value, category: f('category').value, type: f('type').value, rarity: f('rarity').value,
      value: f('value').value === '' ? NaN : Number(f('value').value), demand: Number(f('demand').value),
      trend: f('trend').value, baseFruit: f('base').value, priceBeli: f('price').value, notes: f('notes').value, imageUrl: f('image').value
    };
    try {
      if (editingId) await BH.api('/values/' + editingId, { method: 'PUT', body });
      else await BH.api('/values', { method: 'POST', body });
      closeEditor();
      BH.toast('Value saved.');
      metaLoaded = true;
      load();
    } catch (err) { els.error.textContent = err.message; }
  });

  els.del.addEventListener('click', async () => {
    if (!editingId || !confirm('Delete this item? It will also be removed from trade listings.')) return;
    try {
      await BH.api('/values/' + editingId, { method: 'DELETE' });
      closeEditor();
      BH.toast('Item deleted.');
      load();
    } catch (err) { els.error.textContent = err.message; }
  });

  BH.ready.then((me) => {
    isAdmin = Boolean(me && me.isAdmin);
    els.adminBar.hidden = !isAdmin;
    load();
  });
})();
