/* Staff panel (administrator and Support account): tickets, orders, inventory, player reports,
   warn/ban/unban, and the read-only action log. The server checks the role on every call; this page only shows the tools. */
(function () {
  'use strict';
  const BH = window.BH, h = BH.h;
  const pill = (s) => h('span', { class: 'status-pill s-' + s, text: String(s).replace('_', ' ') });
  const when = (iso) => BH.fmtDate(iso) + ' ' + BH.fmtClock(iso);
  const fail = (e) => BH.toast(e.message, 'error');
  const empty = (box, text) => box.append(h('div', { class: 'empty-box', text }));
  const loaders = {};

  /* ---------- Tabs ---------- */
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); });
    document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
    if (loaders[name]) loaders[name]();
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  /* ---------- Reason dialog (warn / ban / unban) ---------- */
  const dlg = { d: BH.$('#action-dialog'), f: BH.$('#action-form'), title: BH.$('#action-title'), help: BH.$('#action-help'), reason: BH.$('#action-reason'), err: BH.$('#action-error'), go: BH.$('#action-submit') };
  let pending = null;
  function askReason(opts) {
    pending = opts;
    dlg.title.textContent = opts.title; dlg.help.textContent = opts.help; dlg.reason.value = ''; dlg.err.textContent = ''; dlg.go.disabled = false;
    dlg.go.textContent = opts.confirm;
    dlg.d.showModal(); dlg.reason.focus();
  }
  BH.$('#action-close').addEventListener('click', () => dlg.d.close());
  dlg.f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const reason = dlg.reason.value.trim();
    if (pending.required && reason.length < 3) { dlg.err.textContent = 'Give a reason (at least 3 characters).'; return; }
    dlg.go.disabled = true;
    try { await pending.run(reason); dlg.d.close(); BH.toast(pending.done); pending.after(); }
    catch (ex) { dlg.err.textContent = ex.message; dlg.go.disabled = false; }
  });

  /* ---------- Tickets ---------- */
  const tkStatus = BH.$('#tk-status');
  const TK_LABEL = { open: 'Reopen', in_progress: 'Mark in progress', resolved: 'Mark resolved' };
  loaders.tickets = async function () {
    const box = BH.clear(BH.$('#tk-list'));
    try {
      const d = await BH.api('/staff/tickets' + (tkStatus.value ? '?status=' + tkStatus.value : ''));
      if (!d.tickets.length) return empty(box, 'No tickets here.');
      d.tickets.forEach((t) => box.append(h('article', { class: 'card ticket-row' },
        h('div', { class: 'row-head' }, h('b', { text: t.code + ' \u00B7 ' + t.categoryLabel }), pill(t.status)),
        h('div', { class: 'muted' }, 'From ', h('a', { href: '/profile.html?u=' + encodeURIComponent(t.username), text: '@' + t.username }), ' \u00B7 ' + when(t.createdAt)),
        h('p', { class: 'ticket-msg', text: t.message }),
        h('div', { class: 'row-actions' }, d.statuses.filter((s) => s !== t.status).map((s) =>
          h('button', { class: 'btn ghost small', type: 'button', text: TK_LABEL[s], onclick: async () => {
            try { await BH.api('/staff/tickets/' + t.id, { method: 'PATCH', body: { status: s } }); loaders.tickets(); } catch (e) { fail(e); }
          } }))))));
    } catch (e) { empty(box, e.message); }
  };
  tkStatus.addEventListener('change', loaders.tickets);

  /* ---------- Orders ---------- */
  const orStatus = BH.$('#or-status');
  const OR_LABEL = { paid: 'Mark paid', processing: 'Start processing', completed: 'Mark completed', cancelled: 'Cancel and return stock' };
  loaders.orders = async function () {
    const box = BH.clear(BH.$('#or-list'));
    try {
      const d = await BH.api('/staff/orders' + (orStatus.value ? '?status=' + orStatus.value : ''));
      if (!d.orders.length) return empty(box, 'No orders here.');
      d.orders.forEach((o) => box.append(h('article', { class: 'card order-row' },
        h('div', { class: 'row-head' }, h('b', { text: '#' + o.id + ' \u00B7 ' + o.qty + ' \u00D7 ' + o.itemName + ' \u00B7 ' + BH.fmtNpr(o.totalNpr) }), pill(o.status)),
        h('div', { class: 'muted' }, 'Buyer ', h('a', { href: '/profile.html?u=' + encodeURIComponent(o.username), text: '@' + o.username }),
          ' \u00B7 deliver to ' + o.robloxUsername + ' \u00B7 ref ' + o.paymentRef + ' \u00B7 ' + when(o.createdAt)),
        o.note ? h('p', { class: 'ticket-msg', text: 'Note: ' + o.note }) : null,
        o.nextStatuses.length ? h('div', { class: 'row-actions' }, o.nextStatuses.map((s) =>
          h('button', { class: 'btn small' + (s === 'cancelled' ? ' danger' : ' ghost'), type: 'button', text: OR_LABEL[s], onclick: async () => {
            if (s === 'cancelled' && !confirm('Cancel order #' + o.id + ' and return ' + o.qty + ' to stock?')) return;
            try { await BH.api('/staff/orders/' + o.id, { method: 'PATCH', body: { status: s } }); loaders.orders(); } catch (e) { fail(e); }
          } }))) : null)));
    } catch (e) { empty(box, e.message); }
  };
  orStatus.addEventListener('change', loaders.orders);

  /* ---------- Inventory ---------- */
  const invQ = BH.$('#inv-q'), invOut = BH.$('#inv-out');
  function invRow(it) {
    const stock = h('input', { type: 'number', min: '0', step: '1', value: String(it.stock), id: 'inv-s-' + it.id });
    const price = h('input', { type: 'number', min: '0', step: '1', value: String(it.priceNpr), id: 'inv-p-' + it.id });
    const state = h('span', {});
    const row = h('article', { class: 'card inv-row' },
      h('div', { class: 'store-top' }, BH.itemBadge(it), h('div', {}, h('b', { text: it.name }), h('div', { class: 'muted', text: it.category + ' \u00B7 ' + it.rarity }), state)));
    const paint = (x) => {
      stock.value = String(x.stock); price.value = String(x.priceNpr);
      BH.clear(state).append(x.stock > 0 ? h('span', { class: 'stock-line in', text: x.stock + ' in stock' }) : h('span', { class: 'stock-line out', text: 'OUT OF STOCK' }));
    };
    const send = async (body) => { try { const d = await BH.api('/staff/inventory/' + it.id, { method: 'PATCH', body }); paint(d.item); BH.toast('Saved.'); refreshCounts(); } catch (e) { fail(e); } };
    paint(it);
    const bump = (n) => h('button', { class: 'btn ghost small', type: 'button', text: (n > 0 ? '+' : '\u2212') + Math.abs(n), 'aria-label': (n > 0 ? 'Add ' : 'Remove ') + Math.abs(n) + ' ' + it.name, onclick: () => send({ delta: n }) });
    row.append(h('div', { class: 'inv-edit' },
      h('label', {}, 'Stock', stock), h('label', {}, 'Price (Rs.)', price),
      h('button', { class: 'btn small', type: 'button', text: 'Save', onclick: () => send({ stock: stock.value, priceNpr: price.value }) }),
      bump(-1), bump(1), bump(10)));
    return row;
  }
  async function refreshCounts() {
    try { const d = await BH.api('/staff/inventory?q=zzzzzz-none'); BH.$('#inv-summary').dataset.out = d.outOfStock; BH.$('#inv-summary').dataset.total = d.total; paintSummary(); } catch (e) { /* ignore */ }
  }
  function paintSummary(shown) {
    const s = BH.$('#inv-summary');
    if (shown !== undefined) s.dataset.shown = shown;
    s.textContent = 'Showing ' + (s.dataset.shown || 0) + ' \u00B7 ' + (s.dataset.out || 0) + ' of ' + (s.dataset.total || 0) + ' items are out of stock';
  }
  loaders.inventory = async function () {
    const box = BH.clear(BH.$('#inv-list'));
    const query = new URLSearchParams();
    if (invQ.value.trim()) query.set('q', invQ.value.trim());
    if (invOut.checked) query.set('out', '1');
    try {
      const d = await BH.api('/staff/inventory?' + query);
      const s = BH.$('#inv-summary'); s.dataset.out = d.outOfStock; s.dataset.total = d.total; paintSummary(d.items.length);
      if (!d.items.length) return empty(box, 'No items match.');
      d.items.forEach((it) => box.append(invRow(it)));
    } catch (e) { empty(box, e.message); }
  };
  invQ.addEventListener('input', BH.debounce(loaders.inventory, 250));
  invOut.addEventListener('change', loaders.inventory);

  /* ---------- Player reports (reports players filed against each other in chat) ---------- */
  loaders.reports = async function () {
    const box = BH.clear(BH.$('#rp-list'));
    try {
      const d = await BH.api('/admin/reports');
      if (!d.reports.length) return empty(box, 'No player reports.');
      d.reports.forEach((r) => box.append(h('article', { class: 'card staff-row' },
        h('div', { class: 'row-head' }, h('b', { text: '#' + r.id + ' \u00B7 ' + r.reason }), pill(r.status)),
        h('div', { class: 'muted', text: '@' + r.reporter + ' reported @' + r.reported + ' \u00B7 ' + when(r.createdAt) }),
        r.details ? h('p', { class: 'ticket-msg', text: r.details }) : null,
        r.evidence.length ? h('pre', { text: r.evidence.map((m) => m.from + ': ' + m.body).join('\n') }) : null,
        r.status === 'open' ? h('div', { class: 'row-actions' }, h('button', { class: 'btn ghost small', type: 'button', text: 'Mark resolved', onclick: async () => {
          try { await BH.api('/admin/reports/' + r.id, { method: 'PATCH', body: {} }); loaders.reports(); } catch (e) { fail(e); }
        } })) : null)));
    } catch (e) { empty(box, e.message); }
  };

  /* ---------- Players: warn / ban / unban ---------- */
  const usQ = BH.$('#us-q');
  loaders.users = async function () {
    const box = BH.clear(BH.$('#us-list'));
    try {
      const d = await BH.api('/staff/users?q=' + encodeURIComponent(usQ.value.trim()));
      if (!d.users.length) return empty(box, 'No players found.');
      d.users.forEach((u) => {
        const act = (verb, title, help, required, confirm, done) => h('button', {
          class: 'btn small ' + (verb === 'ban' ? 'danger' : 'ghost'), type: 'button', text: title,
          onclick: () => askReason({ title: title + ' @' + u.username, help, required, confirm, done,
            run: (reason) => BH.api('/staff/users/' + encodeURIComponent(u.username) + '/' + verb, { method: 'POST', body: { reason } }), after: loaders.users })
        });
        box.append(h('article', { class: 'card staff-row' },
          h('div', { class: 'row-head' },
            h('b', {}, h('a', { href: '/profile.html?u=' + encodeURIComponent(u.username), text: '@' + u.username }), u.role !== 'user' ? ' (' + u.role + ')' : ''),
            u.banned ? pill('banned') : null),
          h('div', { class: 'muted', text: u.displayName + ' \u00B7 joined ' + BH.fmtDate(u.createdAt) + ' \u00B7 ' + u.warnings + ' warning' + (u.warnings === 1 ? '' : 's') + (u.banned && u.banReason ? ' \u00B7 ban reason: ' + u.banReason : '') }),
          u.canModerate ? h('div', { class: 'row-actions' },
            act('warn', 'Warn', 'The player will see this warning in their Settings.', true, 'Send warning', 'Warning sent.'),
            u.banned ? act('unban', 'Unban', 'Optional note for the log.', false, 'Unban', 'Player unbanned.')
              : act('ban', 'Ban', 'Signs them out everywhere, closes their open listings and blocks login. Give a clear reason.', true, 'Ban player', 'Player banned.'),
            u.warnings ? h('button', { class: 'btn ghost small', type: 'button', text: 'Warning history', onclick: async () => {
              try { const w = (await BH.api('/staff/users/' + encodeURIComponent(u.username) + '/warnings')).warnings; alert(w.length ? w.map((x) => when(x.createdAt) + ' by ' + x.moderator + ': ' + x.reason).join('\n\n') : 'No warnings.'); } catch (e) { fail(e); }
            } }) : null) : h('div', { class: 'muted', text: 'This account cannot be moderated from here.' })));
      });
    } catch (e) { empty(box, e.message); }
  };
  usQ.addEventListener('input', BH.debounce(loaders.users, 250));

  /* ---------- Action log ---------- */
  loaders.log = async function () {
    const box = BH.clear(BH.$('#lg-list'));
    try {
      const d = await BH.api('/staff/log?limit=200');
      if (!d.log.length) return empty(box, 'Nothing has been logged yet.');
      d.log.forEach((l) => box.append(h('div', { class: 'card log-row' },
        h('div', { class: 'when', text: when(l.createdAt) }),
        h('div', {}, h('b', { text: l.action }), ' by @' + l.moderator + (l.target ? ' on @' + l.target : ''), l.details ? h('div', { class: 'muted', text: l.details }) : null))));
    } catch (e) { empty(box, e.message); }
  };

  BH.ready.then((me) => {
    if (!me) { location.replace('/login.html?next=%2Fstaff.html'); return; }
    if (!me.isStaff) { location.replace('/index.html'); return; }
    BH.$('#staff-title').textContent = me.isAdmin ? 'Admin panel' : 'Support panel';
    showTab('tickets');
  });
})();
