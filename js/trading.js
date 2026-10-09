/* Trading page: trade checker, fruit picker, listing creation and the listing board.
   (Added next to the files in the requested structure because trading has its own page logic.) */
(function () {
  'use strict';
  const BH = window.BH, h = BH.h;
  const state = { items: new Map(), give: [], get: [], side: 'give' };
  const el = {
    listGive: BH.$('#list-give'), listGet: BH.$('#list-get'),
    totGive: BH.$('#tot-give'), totGet: BH.$('#tot-get'),
    verdict: BH.$('#verdict'), sub: BH.$('#verdict-sub'),
    barGive: BH.$('#bar-give'), barGet: BH.$('#bar-get'), barGiveN: BH.$('#bar-give-n'), barGetN: BH.$('#bar-get-n'),
    picker: BH.$('#picker'), pickerQ: BH.$('#picker-q'), pickerList: BH.$('#picker-list'), pickerTitle: BH.$('#picker-title'),
    form: BH.$('#listing-form'), note: BH.$('#note'), formError: BH.$('#listing-error'), loginPrompt: BH.$('#login-prompt'), loginLink: BH.$('#login-link'),
    board: BH.$('#board'), bq: BH.$('#b-q'), bview: BH.$('#b-view')
  };

  const total = (side) => state[side].reduce((s, e) => s + (state.items.get(e.id) ? state.items.get(e.id).value * e.qty : 0), 0);
  const save = () => BH.draft.save({ give: state.give, get: state.get });

  /* ---------- Trade checker ---------- */
  function renderSide(side) {
    const box = side === 'give' ? el.listGive : el.listGet;
    BH.clear(box);
    if (!state[side].length) box.append(h('div', { class: 'empty-box', text: 'No fruits yet' }));
    state[side].forEach((e) => {
      const it = state.items.get(e.id);
      box.append(h('div', { class: 'trade-item' },
        BH.itemBadge(it),
        h('div', { class: 'nm' }, h('b', { text: it.name }), h('small', { text: BH.fmtValue(it.value * e.qty) + ' estimated value' })),
        h('div', { class: 'qty' },
          h('button', { class: 'icon-btn', type: 'button', text: '\u2212', 'aria-label': 'Remove one ' + it.name, onclick: () => change(side, e.id, -1) }),
          h('span', { text: String(e.qty), 'aria-label': 'Quantity' }),
          h('button', { class: 'icon-btn', type: 'button', text: '+', 'aria-label': 'Add one ' + it.name, onclick: () => change(side, e.id, 1) })),
        h('button', { class: 'icon-btn', type: 'button', text: '\u00D7', 'aria-label': 'Remove ' + it.name + ' from trade', onclick: () => change(side, e.id, -999) })));
    });
  }

  function renderBalance() {
    const g = total('give'), r = total('get'), max = Math.max(g, r, 1);
    el.totGive.textContent = BH.fmtValue(g);
    el.totGet.textContent = BH.fmtValue(r);
    el.barGive.style.width = (g / max * 100) + '%';
    el.barGet.style.width = (r / max * 100) + '%';
    el.barGiveN.textContent = BH.fmtValue(g);
    el.barGetN.textContent = BH.fmtValue(r);
    const c = BH.compare(state.give.length && g, state.get.length && r);
    el.verdict.className = 'verdict ' + c.cls;
    el.verdict.textContent = c.title;
    el.sub.textContent = c.sub;
  }

  function render() { renderSide('give'); renderSide('get'); renderBalance(); save(); }

  function change(side, id, delta) {
    const list = state[side];
    const i = list.findIndex((e) => e.id === id);
    if (i === -1) return;
    list[i].qty = Math.min(99, list[i].qty + delta);
    if (list[i].qty <= 0) list.splice(i, 1);
    render();
    if (el.picker.open) renderPicker();
  }

  function add(side, id) {
    const found = state[side].find((e) => e.id === id);
    if (found) found.qty = Math.min(99, found.qty + 1);
    else if (state[side].length >= 8) { BH.toast('A side can hold up to 8 different fruits.', 'error'); return; }
    else state[side].push({ id, qty: 1 });
    render();
    renderPicker();
  }

  /* ---------- Picker ---------- */
  function renderPicker() {
    const text = el.pickerQ.value.trim().toLowerCase();
    const items = [...state.items.values()].filter((it) => !text || it.name.toLowerCase().includes(text));
    BH.clear(el.pickerList);
    if (!items.length) el.pickerList.append(h('div', { class: 'empty-box', text: 'No fruit matches that search.' }));
    items.forEach((it) => {
      const inTrade = state[state.side].find((e) => e.id === it.id);
      el.pickerList.append(h('button', { class: 'pick', type: 'button', onclick: () => add(state.side, it.id) },
        BH.itemBadge(it),
        h('span', { class: 'nm' }, h('b', { text: it.name }), h('small', { text: it.rarity + ' \u00B7 ' + BH.fmtValue(it.value) })),
        inTrade ? h('span', { class: 'count', text: '\u00D7' + inTrade.qty }) : null));
    });
  }
  function openPicker(side) {
    state.side = side;
    el.pickerTitle.textContent = side === 'give' ? 'Add a fruit you give' : 'Add a fruit you get';
    el.pickerQ.value = '';
    renderPicker();
    el.picker.showModal();
    el.pickerQ.focus();
  }
  BH.$('#add-give').addEventListener('click', () => openPicker('give'));
  BH.$('#add-get').addEventListener('click', () => openPicker('get'));
  BH.$('#picker-done').addEventListener('click', () => el.picker.close());
  el.pickerQ.addEventListener('input', renderPicker);

  /* ---------- Trade actions ---------- */
  BH.$('#swap').addEventListener('click', () => { [state.give, state.get] = [state.get, state.give]; render(); });
  BH.$('#clear').addEventListener('click', () => { state.give = []; state.get = []; render(); });
  BH.$('#copy').addEventListener('click', async () => {
    if (!state.give.length || !state.get.length) { BH.toast('Add fruits to both sides first.', 'error'); return; }
    const names = (side) => state[side].map((e) => state.items.get(e.id).name + (e.qty > 1 ? ' x' + e.qty : '')).join(', ');
    const text = 'Trading: ' + names('give') + ' for ' + names('get') + '. (Estimated values: ' + BH.fmtValue(total('give')) + ' for ' + BH.fmtValue(total('get')) + ')';
    try { await navigator.clipboard.writeText(text); BH.toast('Trade text copied.'); } catch (e) { BH.toast('Could not copy. Select the text manually.', 'error'); }
  });

  /* ---------- Listing creation ---------- */
  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.formError.textContent = '';
    if (!state.give.length || !state.get.length) { el.formError.textContent = 'Add at least one fruit to both sides first.'; return; }
    const map = (side) => state[side].map((x) => ({ itemId: x.id, qty: x.qty }));
    try {
      await BH.api('/trades', { method: 'POST', body: { have: map('give'), want: map('get'), note: el.note.value } });
      el.note.value = '';
      BH.toast('Listing created.');
      el.bview.value = 'mine';
      loadBoard();
      el.board.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) { el.formError.textContent = err.message; }
  });

  /* ---------- Board ---------- */
  async function loadBoard() {
    const mine = el.bview.value === 'mine';
    if (mine && !BH.me) {
      BH.clear(el.board);
      el.board.append(h('div', { class: 'empty-state' }, h('h3', { text: 'Log in to see your listings' }), h('a', { class: 'btn', href: '/login.html?next=/trading.html', text: 'Log in' })));
      return;
    }
    const query = new URLSearchParams();
    if (mine) query.set('mine', '1');
    if (el.bq.value.trim()) query.set('q', el.bq.value.trim());
    try {
      const d = await BH.api('/trades?' + query.toString());
      BH.clear(el.board);
      if (!d.trades.length) {
        el.board.append(h('div', { class: 'empty-state' },
          h('h3', { text: mine ? 'You have no listings yet' : 'No open listings match' }),
          h('p', { text: mine ? 'Build a trade above and post it.' : 'Be the first to post one, or clear the search.' })));
        return;
      }
      d.trades.forEach((t) => el.board.append(BH.renderListing(t, { onStatus: setStatus, onDelete: remove })));
    } catch (err) {
      BH.clear(el.board);
      el.board.append(h('div', { class: 'empty-box', text: err.message }));
    }
  }
  async function setStatus(t, status) {
    try { await BH.api('/trades/' + t.id, { method: 'PATCH', body: { status } }); BH.toast(status === 'closed' ? 'Listing closed.' : 'Listing reopened.'); loadBoard(); }
    catch (err) { BH.toast(err.message, 'error'); }
  }
  async function remove(t) {
    if (!confirm('Delete this listing?')) return;
    try { await BH.api('/trades/' + t.id, { method: 'DELETE' }); BH.toast('Listing deleted.'); loadBoard(); }
    catch (err) { BH.toast(err.message, 'error'); }
  }
  el.bq.addEventListener('input', BH.debounce(loadBoard, 250));
  el.bview.addEventListener('change', loadBoard);

  /* ---------- Start ---------- */
  Promise.all([BH.ready, BH.api('/values?sort=value_desc&limit=500')]).then(([me, vals]) => {
    vals.items.forEach((it) => state.items.set(it.id, it));
    const draft = BH.draft.load();
    state.give = draft.give.filter((e) => state.items.has(e.id) && e.qty > 0).slice(0, 8);
    state.get = draft.get.filter((e) => state.items.has(e.id) && e.qty > 0).slice(0, 8);
    el.form.hidden = !me;
    el.loginPrompt.hidden = Boolean(me);
    el.loginLink.href = '/login.html?next=' + encodeURIComponent('/trading.html');
    render();
    loadBoard();
  }).catch((err) => {
    BH.toast(err.message, 'error');
    BH.clear(el.board);
    el.board.append(h('div', { class: 'empty-box', text: 'Could not load values. Refresh the page to try again.' }));
  });
})();
