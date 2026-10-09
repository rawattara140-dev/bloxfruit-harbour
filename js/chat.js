/* Private one-to-one chat. Messages are rendered with textContent only (never innerHTML).
   Live updates arrive over a server-sent events stream (/api/chat/stream). */
(function () {
  'use strict';
  const BH = window.BH, h = BH.h;
  const layout = BH.$('.chat-layout');
  const el = {
    list: BH.$('#conv-list'), listEmpty: BH.$('#list-empty'),
    threadEmpty: BH.$('#thread-empty'), thread: BH.$('#thread'),
    avatar: BH.$('#thread-avatar'), name: BH.$('#thread-name'), handle: BH.$('#thread-handle'),
    messages: BH.$('#messages'), composer: BH.$('#composer'), input: BH.$('#msg-input'), send: BH.$('#send-btn'),
    blockedNote: BH.$('#blocked-note'), blockBtn: BH.$('#block-btn'), unblockBtn: BH.$('#unblock-btn'), reportBtn: BH.$('#report-btn'),
    newDialog: BH.$('#new-dialog'), newForm: BH.$('#new-form'), newUser: BH.$('#new-username'), newError: BH.$('#new-error'),
    reportDialog: BH.$('#report-dialog'), reportForm: BH.$('#report-form'), reportReason: BH.$('#report-reason'),
    reportDetails: BH.$('#report-details'), reportError: BH.$('#report-error')
  };
  let me = null;
  let convs = [];
  let activeId = null;
  let other = null;
  let blockedByMe = false;
  let messages = [];
  let firstConnect = true;

  /* ---------- Formatting ---------- */
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  function dayLabel(iso) {
    const d = new Date(iso), now = new Date(), y = new Date();
    y.setDate(y.getDate() - 1);
    if (sameDay(d, now)) return 'Today';
    if (sameDay(d, y)) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  const listTime = (iso) => (sameDay(new Date(iso), new Date()) ? BH.fmtClock(iso) : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }));

  /* ---------- Conversation list ---------- */
  function updateBadge() { BH.setUnread(convs.reduce((s, c) => s + (c.id === activeId ? 0 : c.unread), 0)); }

  function renderList() {
    BH.clear(el.list);
    el.listEmpty.hidden = convs.length > 0;
    convs.forEach((c) => {
      const unread = c.id === activeId ? 0 : c.unread;
      const btn = h('button', { class: 'conv' + (c.id === activeId ? ' active' : '') + (unread ? ' unread' : ''), type: 'button', onclick: () => openConversation(c.id) },
        BH.avatar(c.other, 'sm'),
        h('div', { class: 'conv-body' },
          h('div', { class: 'conv-top' }, h('span', { class: 'conv-name', text: c.other.displayName }), h('span', { class: 'conv-time', text: c.lastAt ? listTime(c.lastAt) : '' })),
          h('div', { class: 'conv-bottom' },
            h('span', { class: 'conv-preview', text: c.lastMessage ? (c.lastFromMe ? 'You: ' : '') + c.lastMessage : 'No messages yet' }),
            unread ? h('span', { class: 'unread-count', text: unread > 99 ? '99+' : String(unread), 'aria-label': unread + ' unread messages' }) : null)));
      el.list.append(h('li', {}, btn));
    });
    updateBadge();
  }

  async function loadList() {
    try { convs = (await BH.api('/chat/conversations')).conversations; renderList(); }
    catch (e) { BH.toast(e.message, 'error'); }
  }
  const loadListSoon = BH.debounce(loadList, 150);

  /* ---------- Thread ---------- */
  function renderMessages(stickToBottom) {
    const box = el.messages;
    BH.clear(box);
    if (!messages.length) box.append(h('p', { class: 'empty-thread-hint', text: 'No messages yet. Say hello!' }));
    let prev = null;
    messages.forEach((m) => {
      const day = new Date(m.createdAt);
      if (!prev || !sameDay(prev, day)) box.append(h('div', { class: 'day-sep', text: dayLabel(m.createdAt) }));
      prev = day;
      box.append(h('div', { class: 'msg' + (m.senderId === me.id ? ' mine' : '') }, m.body, h('span', { class: 'msg-time', text: BH.fmtClock(m.createdAt) })));
    });
    if (stickToBottom) box.scrollTop = box.scrollHeight;
  }

  function renderComposerState() {
    el.composer.hidden = blockedByMe;
    el.blockedNote.hidden = !blockedByMe;
    el.blockBtn.hidden = blockedByMe;
  }

  async function openConversation(id) {
    try {
      const d = await BH.api('/chat/conversations/' + id + '/messages');
      activeId = id;
      other = d.other;
      blockedByMe = d.blockedByMe;
      messages = d.messages;
      layout.classList.add('show-thread');
      el.threadEmpty.hidden = true;
      el.thread.hidden = false;
      BH.clear(el.avatar).append(BH.avatar(other, 'sm'));
      el.name.textContent = other.displayName;
      el.name.href = '/profile.html?u=' + encodeURIComponent(other.username);
      el.handle.textContent = '@' + other.username;
      renderComposerState();
      renderMessages(true);
      markRead();
      renderList();
      if (!blockedByMe && !matchMedia('(max-width: 720px)').matches) el.input.focus();
    } catch (e) {
      BH.toast(e.message, 'error');
    }
  }

  async function markRead() {
    if (!activeId) return;
    try {
      await BH.api('/chat/conversations/' + activeId + '/read', { method: 'POST' });
      const c = convs.find((x) => x.id === activeId);
      if (c) { c.unread = 0; renderList(); }
    } catch (e) { /* not critical */ }
  }

  function addMessage(m) {
    if (messages.some((x) => x.id === m.id)) return;
    const box = el.messages;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    messages.push(m);
    renderMessages(nearBottom || m.senderId === me.id);
  }

  /* ---------- Sending ---------- */
  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 140) + 'px';
  }
  el.input.addEventListener('input', autosize);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); el.composer.requestSubmit(); }
  });
  el.composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = el.input.value.trim();
    if (!text || !activeId) return;
    el.send.disabled = true;
    try {
      const m = await BH.api('/chat/conversations/' + activeId + '/messages', { method: 'POST', body: { body: text } });
      el.input.value = '';
      autosize();
      addMessage(m);
      loadListSoon();
    } catch (err) {
      BH.toast(err.message, 'error');
    } finally {
      el.send.disabled = false;
      el.input.focus();
    }
  });

  /* ---------- Live updates ---------- */
  function connect() {
    const source = new EventSource('/api/chat/stream');
    source.addEventListener('message', (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.conversationId === activeId) {
        addMessage(d.message);
        if (d.message.senderId !== me.id && !document.hidden) markRead();
      }
      loadListSoon();
    });
    source.addEventListener('open', async () => {
      if (firstConnect) { firstConnect = false; return; }
      // Reconnected after a drop: catch up on anything we missed.
      loadList();
      if (activeId) {
        const last = messages.length ? messages[messages.length - 1].id : 0;
        try { (await BH.api('/chat/conversations/' + activeId + '/messages?after=' + last)).messages.forEach(addMessage); } catch (e) { /* ignore */ }
      }
    });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) markRead(); });

  /* ---------- Back, block, unblock, report ---------- */
  BH.$('#back').addEventListener('click', () => {
    activeId = null;
    layout.classList.remove('show-thread');
    el.thread.hidden = true;
    el.threadEmpty.hidden = false;
    renderList();
  });

  el.blockBtn.addEventListener('click', async () => {
    if (!other || !confirm('Block ' + other.displayName + '? Neither of you will be able to send messages to the other.')) return;
    try {
      await BH.api('/blocks', { method: 'POST', body: { username: other.username } });
      blockedByMe = true;
      renderComposerState();
      loadList();
      BH.toast('Player blocked.');
    } catch (e) { BH.toast(e.message, 'error'); }
  });
  el.unblockBtn.addEventListener('click', async () => {
    try {
      await BH.api('/blocks/' + encodeURIComponent(other.username), { method: 'DELETE' });
      blockedByMe = false;
      renderComposerState();
      loadList();
      BH.toast('Player unblocked.');
    } catch (e) { BH.toast(e.message, 'error'); }
  });

  el.reportBtn.addEventListener('click', () => {
    el.reportError.textContent = '';
    el.reportDetails.value = '';
    el.reportDialog.showModal();
  });
  BH.$('#report-close').addEventListener('click', () => el.reportDialog.close());
  el.reportForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await BH.api('/reports', { method: 'POST', body: { username: other.username, conversationId: activeId, reason: el.reportReason.value, details: el.reportDetails.value } });
      el.reportDialog.close();
      BH.toast('Report sent. Thank you.');
    } catch (err) { el.reportError.textContent = err.message; }
  });

  /* ---------- New chat ---------- */
  async function startChat(username) {
    const d = await BH.api('/chat/conversations', { method: 'POST', body: { username } });
    await loadList();
    await openConversation(d.id);
  }
  function openNewDialog() {
    el.newError.textContent = '';
    el.newUser.value = '';
    el.newDialog.showModal();
    el.newUser.focus();
  }
  BH.$('#new-chat').addEventListener('click', openNewDialog);
  BH.$('#new-chat-empty').addEventListener('click', openNewDialog);
  BH.$('#new-close').addEventListener('click', () => el.newDialog.close());
  el.newForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el.newUser.value.trim().replace(/^@/, '');
    if (!name) { el.newError.textContent = 'Enter a username.'; return; }
    try { await startChat(name); el.newDialog.close(); }
    catch (err) { el.newError.textContent = err.message; }
  });

  /* ---------- Start ---------- */
  BH.ready.then(async (user) => {
    if (!user) { location.replace('/login.html?next=/chat.html'); return; }
    me = user;
    await loadList();
    connect();
    const withUser = new URLSearchParams(location.search).get('with');
    if (withUser) {
      history.replaceState(null, '', '/chat.html');
      try { await startChat(withUser.replace(/^@/, '')); } catch (err) { BH.toast(err.message, 'error'); }
    }
  });
})();
