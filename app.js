/* Bloxfruit Harbour: shared code loaded on every page.
   Page scripts (values.js, trading.js, chat.js, profile.js, auth.js) wait for BH.ready. */
(function () {
  'use strict';
  const BH = (window.BH = {});
  BH.page = document.body.dataset.page || '';
  BH.me = null;
  BH.robloxEnabled = false;
  BH.googleEnabled = false;

  /* ---------- DOM helper (builds elements with textContent, so user text is never parsed as HTML) ---------- */
  BH.h = function (tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };
  const h = BH.h;
  BH.$ = (sel, root) => (root || document).querySelector(sel);
  BH.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  BH.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  /* ---------- API ---------- */
  BH.api = async function (path, opts) {
    const { method = 'GET', body } = opts || {};
    const init = { method, credentials: 'same-origin', headers: { 'X-BH-CSRF': '1' } };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let res;
    try { res = await fetch('/api' + path, init); } catch (e) { throw Object.assign(new Error('Could not reach the server. Check your connection.'), { status: 0 }); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) throw Object.assign(new Error((data && data.error) || 'Something went wrong. Please try again.'), { status: res.status });
    return data;
  };

  /* ---------- Formatting ---------- */
  const trim = (n) => String(Math.round(n * 100) / 100);
  // Values are stored in millions: 0.005 shows as 5K, 600 as 600M, 3990 as 3.99B.
  BH.fmtValue = (v) => { v = Number(v) || 0; return v >= 1000 ? trim(v / 1000) + 'B' : v > 0 && v < 1 ? trim(v * 1000) + 'K' : trim(v) + 'M'; };
  BH.fmtBeli = (n) => (n === null || n === undefined ? 'Not sold in shop' : n >= 1e6 ? trim(n / 1e6) + 'M Beli' : trim(n / 1e3) + 'K Beli');
  // Whole Nepalese rupees, grouped the Nepali way (Rs. 1,25,000).
  BH.fmtNpr = (n) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN');
  BH.fmtDate = (iso) => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  BH.fmtClock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  BH.ago = function (iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 7 * 86400) return Math.floor(s / 86400) + 'd ago';
    return BH.fmtDate(iso);
  };
  BH.safeNext = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v : '/index.html');

  /* ---------- Toasts ---------- */
  BH.toast = function (msg, type) {
    let wrap = BH.$('.toast-wrap');
    if (!wrap) { wrap = h('div', { class: 'toast-wrap', role: 'status', 'aria-live': 'polite' }); document.body.append(wrap); }
    const t = h('div', { class: 'toast' + (type === 'error' ? ' error' : ''), text: msg });
    wrap.append(t);
    setTimeout(() => t.remove(), 3200);
  };

  /* ---------- Reusable components ---------- */
  BH.rarityClass = (r) => 'r-' + String(r || 'Common').replace(/[^A-Za-z]/g, '');
  BH.safeAvatar = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && x.hostname.endsWith('.rbxcdn.com'); } catch (e) { return false; } };
  BH.avatar = function (user, size) {
    const sm = size === 'sm' ? ' sm' : '';
    if (user.avatarUrl && BH.safeAvatar(user.avatarUrl)) {
      return h('img', { class: 'avatar' + sm, src: user.avatarUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    }
    const name = user.displayName || user.username || '?';
    let hash = 0;
    for (const c of user.username || name) hash = (hash * 31 + c.charCodeAt(0)) % 6;
    return h('div', { class: 'avatar-fallback' + sm + ' av-' + hash, 'aria-hidden': 'true', text: name.charAt(0).toUpperCase() });
  };
  // Fruit picture from our own image cache (/img/fruit/:id). If it fails: generic icon, then the first letter.
  BH.itemBadge = function (it, size) {
    const id = it.id !== undefined ? it.id : it.itemId;
    const letter = String(it.name || '?').charAt(0);
    const badge = h('span', { class: 'badge ' + BH.rarityClass(it.rarity) + (size === 'lg' ? ' lg' : ''), 'aria-hidden': 'true' });
    if (id === undefined || id === null) { badge.textContent = letter; return badge; }
    const img = h('img', { src: '/img/fruit/' + encodeURIComponent(id), alt: '', loading: 'lazy', decoding: 'async' });
    let fellBack = false;
    img.addEventListener('error', () => {
      if (!fellBack) { fellBack = true; img.src = '/assets/images/fruit-fallback.svg'; } else { img.remove(); badge.textContent = letter; }
    });
    badge.append(img);
    return badge;
  };
  BH.demandMeter = function (n) {
    const w = h('div', { class: 'demand', role: 'img', 'aria-label': 'Demand ' + n + ' out of 10' });
    for (let i = 1; i <= 10; i++) w.append(h('span', { class: i <= n ? 'pip on' : 'pip' }));
    return w;
  };
  BH.trendLabel = (t) => ({ rising: 'Rising \u25B2', falling: 'Falling \u25BC', stable: 'Stable \u25CF' }[t] || 'Stable \u25CF');
  BH.itemCard = function (it, extra) {
    return h('article', { class: 'card item-card' },
      h('div', { class: 'item-top' }, BH.itemBadge(it),
        h('div', { class: 'item-title' }, h('h3', { text: it.name }), h('span', { class: 'pill ' + BH.rarityClass(it.rarity), text: it.rarity }))),
      h('div', { class: 'item-value' }, h('strong', { text: BH.fmtValue(it.value) }), h('span', { class: 'muted', text: 'trade value' })),
      h('div', { class: 'item-meta' },
        h('div', {}, h('small', { text: 'Demand' }), BH.demandMeter(it.demand)),
        h('div', {}, h('small', { text: 'Trend' }), h('span', { class: 'trend trend-' + it.trend, text: BH.trendLabel(it.trend) }))),
      extra || null);
  };

  // Compares two totals. Never claims a trade is guaranteed fair.
  BH.compare = function (give, get) {
    if (!give || !get) return { cls: 'idle', title: 'Add fruits to both sides', sub: 'The checker compares the estimated total value of each side.' };
    const diff = get - give;
    const pct = Math.abs(diff) / Math.max(give, get);
    if (pct <= 0.1) return { cls: 'fair', title: 'Roughly equal', sub: 'The estimated totals are within about 10% of each other.' };
    if (diff > 0) return { cls: 'higher', title: 'Estimated value is higher on the get side', sub: 'You would get about ' + BH.fmtValue(diff) + ' more estimated value (' + Math.round(pct * 100) + '% more than you give).' };
    return { cls: 'lower', title: 'Estimated value is higher on the give side', sub: 'You would give about ' + BH.fmtValue(-diff) + ' more estimated value (' + Math.round(pct * 100) + '% more than you get).' };
  };

  BH.chip = (it) => h('span', { class: 'chip' }, BH.itemBadge(it), it.name, it.qty > 1 ? h('em', { text: '\u00D7' + it.qty }) : null);
  BH.chipList = (items) => h('div', { class: 'chips' }, items.map(BH.chip));

  // Trade listing card used on the Trading page and on profiles.
  BH.renderListing = function (t, opts) {
    const o = opts || {};
    const mine = BH.me && BH.me.username === t.user.username;
    const est = t.valueHave === 0 || t.valueWant === 0 ? ''
      : (Math.abs(t.valueHave - t.valueWant) / Math.max(t.valueHave, t.valueWant) <= 0.1 ? 'Roughly equal on paper'
        : t.valueHave > t.valueWant ? 'Offers more estimated value than it asks for' : 'Asks for more estimated value than it offers');
    const actions = [];
    if (mine) {
      actions.push(h('button', { class: 'btn ghost small', type: 'button', text: t.status === 'open' ? 'Mark as closed' : 'Reopen', onclick: () => o.onStatus && o.onStatus(t, t.status === 'open' ? 'closed' : 'open') }));
      actions.push(h('button', { class: 'btn danger small', type: 'button', text: 'Delete', onclick: () => o.onDelete && o.onDelete(t) }));
    } else if (BH.me) {
      actions.push(h('a', { class: 'btn small', href: '/chat.html?with=' + encodeURIComponent(t.user.username), text: 'Message ' + t.user.displayName }));
    } else {
      actions.push(h('a', { class: 'btn small', href: '/login.html?next=' + encodeURIComponent(location.pathname + location.search), text: 'Log in to message' }));
    }
    return h('article', { class: 'card listing' + (t.status === 'closed' ? ' closed' : '') },
      h('div', { class: 'listing-head' },
        BH.avatar(t.user, 'sm'),
        h('div', { class: 'who' },
          h('b', {}, h('a', { href: '/profile.html?u=' + encodeURIComponent(t.user.username), text: t.user.displayName })),
          h('small', { text: '@' + t.user.username + ' \u00B7 ' + BH.ago(t.createdAt) })),
        t.status === 'closed' ? h('span', { class: 'tag-closed', text: 'Closed' }) : null),
      h('div', { class: 'listing-cols' },
        h('div', {}, h('h4', { text: 'Has (' + BH.fmtValue(t.valueHave) + ')' }), BH.chipList(t.have)),
        h('div', {}, h('h4', { text: 'Wants (' + BH.fmtValue(t.valueWant) + ')' }), BH.chipList(t.want))),
      t.note ? h('p', { class: 'listing-note', text: t.note }) : null,
      h('div', { class: 'listing-foot' }, h('span', { class: 'est', text: est }), h('div', { class: 'actions' }, actions)));
  };

  /* ---------- Local trade draft (shared by Values quick-add and the Trading page) ---------- */
  BH.draft = {
    load() {
      try {
        const d = JSON.parse(localStorage.getItem('bh-trade-draft') || 'null');
        if (d && Array.isArray(d.give) && Array.isArray(d.get)) return d;
      } catch (e) { /* ignore */ }
      return { give: [], get: [] };
    },
    save(d) { try { localStorage.setItem('bh-trade-draft', JSON.stringify(d)); } catch (e) { /* storage may be blocked */ } }
  };

  /* ---------- Header and footer (same on every page) ---------- */
  const NAV = [['home', 'Home', '/index.html'], ['values', 'Values', '/values.html'], ['trading', 'Trading', '/trading.html'], ['store', 'Store', '/store.html'], ['chat', 'Chat', '/chat.html'], ['contact', 'Contact', '/contact.html'], ['profile', 'Profile', '/profile.html']];

  function renderHeader() {
    const header = BH.$('#site-header');
    if (!header) return;
    const links = NAV.map(([key, label, href]) => {
      const a = h('a', { class: 'nav-link' + (BH.page === key ? ' active' : ''), href, text: label });
      if (BH.page === key) a.setAttribute('aria-current', 'page');
      if (key === 'chat') a.append(h('span', { class: 'nav-badge', id: 'nav-unread', hidden: true, 'aria-label': 'unread messages' }));
      return a;
    });
    const auth = h('div', { class: 'nav-auth', id: 'nav-auth' });
    const toggle = h('button', { class: 'nav-toggle', type: 'button', 'aria-label': 'Open menu', 'aria-expanded': 'false', 'aria-controls': 'nav-menu' }, h('span'));
    toggle.addEventListener('click', () => {
      const open = header.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    header.append(h('div', { class: 'container nav-inner' },
      h('a', { class: 'brand', href: '/index.html' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true', text: 'B' }), h('span', { text: 'Bloxfruit Harbour' })),
      toggle,
      h('nav', { class: 'nav-menu', id: 'nav-menu', 'aria-label': 'Main' }, links, auth)));
  }

  function renderAuthArea() {
    const box = BH.$('#nav-auth');
    if (!box) return;
    BH.clear(box);
    if (BH.me) {
      if (BH.me.isStaff) box.append(h('a', { class: 'btn small' + (BH.page === 'staff' ? ' secondary' : ''), href: '/staff.html', text: BH.me.isAdmin ? 'Admin' : 'Support' }));
      box.append(
        h('span', { class: 'nav-user', text: '@' + BH.me.username }),
        h('button', { class: 'btn ghost small', type: 'button', text: 'Log out', onclick: async () => {
          try { await BH.api('/auth/logout', { method: 'POST' }); } catch (e) { /* still leave */ }
          location.href = '/index.html';
        } }));
    } else {
      box.append(
        h('a', { class: 'btn ghost small', href: '/login.html', text: 'Log in' }),
        h('a', { class: 'btn small', href: '/register.html', text: 'Sign up' }));
    }
  }

  function renderFooter() {
    const f = BH.$('#site-footer');
    if (!f) return;
    const col = (title, links) => h('div', {}, h('h3', { text: title }), h('ul', {}, links.map(([label, href, ext]) =>
      h('li', {}, h('a', Object.assign({ href, text: label }, ext ? { target: '_blank', rel: 'noopener noreferrer' } : {}))))));
    f.append(h('div', { class: 'container' },
      h('div', { class: 'footer-grid' },
        h('div', {}, h('a', { class: 'brand', href: '/index.html' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true', text: 'B' }), h('span', { text: 'Bloxfruit Harbour' })),
          h('p', { class: 'muted', text: 'Trading values, trade listings and private chat for Blox Fruits players.' })),
        col('Explore', [['Home', '/index.html'], ['Values', '/values.html'], ['Trading', '/trading.html'], ['Store', '/store.html']]),
        col('Account', [['Profile', '/profile.html'], ['Messages', '/chat.html'], ['Contact support', '/contact.html'], ['Settings', '/settings.html'], ['Log in', '/login.html'], ['Sign up', '/register.html']]),
        col('Elsewhere', [['Roblox', 'https://www.roblox.com', true], ['Roblox Support', 'https://en.help.roblox.com', true]])),
      h('p', { class: 'footer-note', text: 'Bloxfruit Harbour is a fan-made community site. It is not affiliated with Roblox Corporation or the Blox Fruits developers. Values are estimates and change often. We never ask for your Roblox password.' })));
  }

  BH.setUnread = function (n) {
    const b = BH.$('#nav-unread');
    if (!b) return;
    b.hidden = !n;
    b.textContent = n > 99 ? '99+' : String(n || '');
  };
  async function pollUnread() {
    if (!BH.me || document.hidden) return;
    try { BH.setUnread((await BH.api('/chat/unread')).unread); } catch (e) { /* ignore */ }
  }

  renderHeader();
  renderFooter();

  BH.ready = BH.api('/auth/me')
    .then((d) => { BH.me = d.user; BH.robloxEnabled = d.robloxEnabled; BH.googleEnabled = d.googleEnabled; })
    .catch(() => { BH.me = null; })
    .then(() => {
      renderAuthArea();
      if (BH.me && BH.page !== 'chat') { pollUnread(); setInterval(pollUnread, 30000); }
      return BH.me;
    });

  /* ---------- Home page ---------- */
  async function initHome() {
    const spot = BH.$('#spotlight-list'), featured = BH.$('#featured'), popular = BH.$('#popular'), updates = BH.$('#updates');
    try {
      const [sp, feat, pop, upd] = await Promise.all([
        BH.api('/values?category=Special&sort=value_desc&limit=4'),
        BH.api('/values?sort=value_desc&limit=6'),
        BH.api('/values?sort=demand&limit=8'),
        BH.api('/values/updates?limit=6')
      ]);
      BH.clear(spot);
      if (!sp.items.length) spot.append(h('p', { class: 'muted', text: 'No special items yet.' }));
      sp.items.forEach((it) => spot.append(h('div', { class: 'spot-row' },
        h('div', { class: 'name' }, BH.itemBadge(it), h('div', {}, h('div', { text: it.name }), h('small', { class: 'muted', text: '\u2248 approximate value' }))),
        h('strong', { text: '\u2248 ' + BH.fmtValue(it.value) }))));
      const fill = (el, items) => { BH.clear(el); items.forEach((it) => el.append(BH.itemCard(it))); };
      fill(featured, feat.items);
      fill(popular, pop.items);
      BH.clear(updates);
      if (!upd.updates.length) updates.append(h('div', { class: 'empty-box', text: 'No value changes yet. Updates appear here when the team edits a value.' }));
      upd.updates.forEach((u) => updates.append(h('div', { class: 'card update-row' },
        BH.itemBadge({ id: u.itemId, name: u.name, rarity: u.rarity }),
        h('div', { class: 'what' },
          h('b', { text: u.name }),
          h('div', { class: 'muted', text: u.oldValue === null ? 'Added at ' + BH.fmtValue(u.newValue) : 'Changed from ' + BH.fmtValue(u.oldValue) + ' to ' + BH.fmtValue(u.newValue) })),
        h('span', { class: 'when', text: BH.ago(u.changedAt) }))));
    } catch (e) {
      [spot, featured, popular, updates].forEach((el) => { BH.clear(el); el.append(h('div', { class: 'empty-box', text: 'Could not load values right now. Refresh the page to try again.' })); });
    }

    // Live search suggestions
    const form = BH.$('#hero-search'), input = BH.$('#hero-q'), list = BH.$('#suggest');
    const hide = () => { list.hidden = true; BH.clear(list); };
    input.addEventListener('input', BH.debounce(async () => {
      const text = input.value.trim();
      if (!text) return hide();
      try {
        const d = await BH.api('/values?sort=value_desc&limit=6&q=' + encodeURIComponent(text));
        BH.clear(list);
        if (!d.items.length) list.append(h('li', {}, h('a', { href: '/values.html?q=' + encodeURIComponent(text), text: 'No match. Search all values for "' + text + '"' })));
        d.items.forEach((it) => list.append(h('li', {}, h('a', { href: '/values.html?q=' + encodeURIComponent(it.name) }, h('span', { text: it.name }), h('span', { class: 'v', text: BH.fmtValue(it.value) })))));
        list.hidden = false;
      } catch (e) { hide(); }
    }, 200));
    document.addEventListener('click', (e) => { if (!form.contains(e.target)) hide(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      location.href = '/values.html' + (input.value.trim() ? '?q=' + encodeURIComponent(input.value.trim()) : '');
    });
  }
  if (BH.page === 'home') initHome();
})();
