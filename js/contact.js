/* Contact / report a problem: create tickets and follow their status. */
(function () {
  'use strict';
  const BH = window.BH, h = BH.h;
  const form = BH.$('#ticket-form'), msg = BH.$('#t-message'), cat = BH.$('#t-category'), err = BH.$('#ticket-error');
  const list = BH.$('#my-tickets'), section = BH.$('#my-tickets-section');

  msg.addEventListener('input', () => { BH.$('#t-count').textContent = msg.value.length + ' / 2000'; });

  async function loadTickets() {
    try {
      const d = await BH.api('/tickets');
      section.hidden = !d.tickets.length;
      BH.clear(list);
      d.tickets.forEach((t) => list.append(h('article', { class: 'card ticket-row' },
        h('div', { class: 'row-head' }, h('b', { text: t.code + ' \u00B7 ' + t.categoryLabel }), h('span', { class: 'status-pill s-' + t.status, text: t.status.replace('_', ' ') })),
        h('div', { class: 'muted', text: 'Sent ' + BH.fmtDate(t.createdAt) + ' \u00B7 ' + BH.ago(t.createdAt) }),
        h('p', { class: 'ticket-msg', text: t.message }))));
    } catch (e) { /* not critical */ }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (msg.value.trim().length < 10) { err.textContent = 'Please describe the problem in at least 10 characters.'; return; }
    try {
      const d = await BH.api('/tickets', { method: 'POST', body: { category: cat.value, message: msg.value } });
      msg.value = ''; BH.$('#t-count').textContent = '0 / 2000';
      BH.toast('Ticket ' + d.ticket.code + ' sent.');
      loadTickets();
    } catch (ex) { err.textContent = ex.message; }
  });

  BH.ready.then((me) => {
    form.hidden = !me;
    BH.$('#ticket-login').hidden = Boolean(me);
    if (me) loadTickets();
  });
})();
