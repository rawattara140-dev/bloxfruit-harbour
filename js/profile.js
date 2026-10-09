/* Profile page (own and public) and the Settings page. */
(function () {
  'use strict';
  const BH = window.BH, h = BH.h;

  /* ---------- Profile ---------- */
  async function initProfile() {
    const root = BH.$('#profile-root');
    const me = await BH.ready;
    const u = new URLSearchParams(location.search).get('u');
    const isSelf = !u || Boolean(me && me.username.toLowerCase() === u.toLowerCase());
    if (isSelf && !me) { location.replace('/login.html?next=/profile.html'); return; }

    let data;
    try { data = await BH.api(isSelf ? '/profile/me' : '/users/' + encodeURIComponent(u)); }
    catch (e) {
      BH.clear(root);
      root.append(h('div', { class: 'empty-state' }, h('h1', { text: 'Profile not found' }), h('p', { text: e.message }), h('a', { class: 'btn', href: '/trading.html', text: 'Browse trade listings' })));
      return;
    }
    const p = data.profile;
    document.title = p.displayName + ': Bloxfruit Harbour';
    BH.clear(root);

    const rbx = p.roblox;
    const main = h('div', { class: 'profile-main' },
      h('h1', { text: p.displayName }),
      h('div', { class: 'handle', text: '@' + p.username + ' \u00B7 Joined ' + BH.fmtDate(p.createdAt) }),
      p.bio ? h('p', { text: p.bio }) : (isSelf ? h('p', { class: 'muted', text: 'You have not written a bio yet.' }) : null),
      rbx ? h('div', { class: 'roblox-tag' },
        h('span', { text: 'Roblox:' }),
        h('a', { href: rbx.profileUrl, target: '_blank', rel: 'noopener noreferrer', text: (rbx.displayName || rbx.username || 'Roblox profile') + (rbx.username ? ' (@' + rbx.username + ')' : '') }),
        rbx.hidden ? h('span', { class: 'muted', text: '\u00B7 hidden from others' }) : h('span', { class: 'muted', text: '\u00B7 connected with Roblox sign-in' }))
        : (isSelf ? h('div', { class: 'roblox-tag' }, h('span', { class: 'muted', text: 'No Roblox account connected.' }), h('a', { href: '/settings.html', text: 'Connect in Settings' })) : null));

    const actions = h('div', { class: 'actions' });
    if (isSelf) actions.append(h('a', { class: 'btn secondary', href: '/settings.html', text: 'Edit profile and settings' }));
    else if (me) actions.append(h('a', { class: 'btn', href: '/chat.html?with=' + encodeURIComponent(p.username), text: 'Message ' + p.displayName }));
    else actions.append(h('a', { class: 'btn', href: '/login.html?next=' + encodeURIComponent(location.pathname + location.search), text: 'Log in to message' }));
    main.append(actions);

    const avatarUser = { username: p.username, displayName: p.displayName, avatarUrl: rbx && !rbx.hidden ? rbx.avatarUrl : (isSelf && rbx ? rbx.avatarUrl : null) };
    root.append(
      h('section', { class: 'card profile-head' }, BH.avatar(avatarUser), main),
      h('div', { class: 'stats-row' },
        h('div', { class: 'card stat' }, h('strong', { text: String(data.stats.open) }), 'Open listings'),
        h('div', { class: 'card stat' }, h('strong', { text: String(data.stats.closed) }), 'Closed listings'),
        h('div', { class: 'card stat' }, h('strong', { text: String(data.stats.total) }), 'Total created')));

    const section = h('section', { 'aria-labelledby': 'listings-h' }, h('div', { class: 'section-head' }, h('h2', { id: 'listings-h', text: isSelf ? 'Your trade listings' : 'Open trade listings' })));
    const stack = h('div', { class: 'listing-stack' });
    section.append(stack);
    root.append(section);

    const reload = () => initProfile();
    if (!data.listings.length) {
      stack.append(h('div', { class: 'empty-state card' },
        h('h3', { text: isSelf ? 'No listings yet' : 'No open listings' }),
        h('p', { text: isSelf ? 'Build a trade and post it so other players can find you.' : 'This player has nothing open right now.' }),
        isSelf ? h('a', { class: 'btn', href: '/trading.html', text: 'Create a listing' }) : null));
    }
    data.listings.forEach((t) => stack.append(BH.renderListing(t, {
      onStatus: async (tr, status) => { try { await BH.api('/trades/' + tr.id, { method: 'PATCH', body: { status } }); reload(); } catch (e) { BH.toast(e.message, 'error'); } },
      onDelete: async (tr) => { if (!confirm('Delete this listing?')) return; try { await BH.api('/trades/' + tr.id, { method: 'DELETE' }); reload(); } catch (e) { BH.toast(e.message, 'error'); } }
    })));
  }

  /* ---------- Settings ---------- */
  async function initSettings() {
    const me = await BH.ready;
    if (!me) { location.replace('/login.html?next=/settings.html'); return; }

    // Result of the Roblox sign-in redirect
    const rbxMsg = {
      connected: ['Roblox account connected.'],
      cancelled: ['Roblox connection cancelled.'],
      taken: ['That Roblox account is already linked to another Harbour account.', 'error'],
      unavailable: ['Roblox connection is not set up on this server yet.', 'error'],
      error: ['Could not connect to Roblox. Please try again.', 'error']
    }[new URLSearchParams(location.search).get('roblox')];
    if (rbxMsg) { BH.toast(rbxMsg[0], rbxMsg[1]); history.replaceState(null, '', '/settings.html'); }

    const googleMsg = {
      connected: ['Google account connected.'], cancelled: ['Google connection cancelled.'],
      taken: ['That Google account is already linked to another Harbour account.', 'error'],
      unavailable: ['Google sign-in is not set up on this server yet.', 'error'],
      unverified: ['Google did not confirm that email address, so it was not connected.', 'error'],
      adminconflict: ['The support email must be connected to a separate, non-admin account.', 'error'],
      error: ['Could not connect to Google. Please try again.', 'error']
    }[new URLSearchParams(location.search).get('google')];
    if (googleMsg) { BH.toast(googleMsg[0], googleMsg[1]); history.replaceState(null, '', '/settings.html'); }

    const data = await BH.api('/profile/me');
    const p = data.profile;

    // Profile form
    const pf = BH.$('#profile-form');
    BH.$('#p-display').value = p.displayName;
    BH.$('#p-bio').value = p.bio;
    BH.$('#p-show-roblox').checked = p.showRoblox;
    pf.addEventListener('submit', async (e) => {
      e.preventDefault();
      BH.$('#profile-error').textContent = '';
      try {
        await BH.api('/profile/me', { method: 'PATCH', body: { displayName: BH.$('#p-display').value, bio: BH.$('#p-bio').value, showRoblox: BH.$('#p-show-roblox').checked } });
        BH.toast('Profile saved.');
      } catch (err) { BH.$('#profile-error').textContent = err.message; }
    });

    // Roblox box
    function renderRoblox(rbx) {
      const box = BH.clear(BH.$('#roblox-box'));
      if (rbx) {
        box.append(
          h('div', { class: 'list-row' },
            h('div', { class: 'row-left' },
              BH.avatar({ username: p.username, displayName: rbx.displayName || p.displayName, avatarUrl: rbx.avatarUrl }, 'sm'),
              h('div', {}, h('b', { text: rbx.displayName || rbx.username }), h('div', { class: 'muted', text: rbx.username ? '@' + rbx.username : '' }))),
            h('button', { class: 'btn danger small', type: 'button', text: 'Disconnect', onclick: async () => {
              if (!confirm('Disconnect your Roblox account?')) return;
              try { await BH.api('/auth/roblox/disconnect', { method: 'POST' }); renderRoblox(null); BH.toast('Roblox account disconnected.'); } catch (err) { BH.toast(err.message, 'error'); }
            } })));
      } else if (BH.robloxEnabled) {
        box.append(h('a', { class: 'btn', href: '/api/auth/roblox/start', text: 'Connect with Roblox' }));
      } else {
        box.append(h('p', { class: 'callout', text: 'Roblox connection is not configured on this server yet. The site owner needs to add Roblox OAuth credentials (see the README).' }));
      }
    }
    renderRoblox(p.roblox);

    // Google
    function renderGoogle(email) {
      const box = BH.clear(BH.$('#google-box'));
      if (email) {
        box.append(h('div', { class: 'list-row' },
          h('div', {}, h('b', { text: email }), h('div', { class: 'muted', text: me.isSupport ? 'Support account (verified)' : 'Connected' })),
          h('button', { class: 'btn danger small', type: 'button', text: 'Disconnect', onclick: async () => {
            if (!confirm('Disconnect your Google account?' + (me.isSupport ? ' You will lose support access until you reconnect it.' : ''))) return;
            try { await BH.api('/auth/google/disconnect', { method: 'POST' }); location.reload(); } catch (err) { BH.toast(err.message, 'error'); }
          } })));
      } else if (BH.googleEnabled) {
        box.append(h('a', { class: 'btn', href: '/api/auth/google/start?mode=link', text: 'Connect Google' }));
      } else {
        box.append(h('p', { class: 'callout', text: 'Google sign-in is not configured on this server yet. The site owner needs to add Google OAuth credentials (see the README).' }));
      }
    }
    renderGoogle(data.account && data.account.googleEmail);

    // Warnings the account has received
    try {
      const w = (await BH.api('/account/warnings')).warnings;
      if (w.length) {
        BH.$('#warnings-section').hidden = false;
        const box = BH.clear(BH.$('#warnings-list'));
        w.forEach((x) => box.append(h('div', { class: 'report-card' }, h('b', { text: BH.fmtDate(x.createdAt) }), h('p', { text: x.reason }))));
      }
    } catch (err) { /* not critical */ }

    // Password
    BH.$('#password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = BH.$('#password-error');
      err.textContent = '';
      const cur = BH.$('#pw-current').value, next = BH.$('#pw-new').value;
      if (next.length < 8) { err.textContent = 'New password must be at least 8 characters.'; return; }
      if (next !== BH.$('#pw-confirm').value) { err.textContent = 'The new passwords do not match.'; return; }
      try {
        await BH.api('/account/password', { method: 'POST', body: { currentPassword: cur, newPassword: next } });
        e.target.reset();
        BH.toast('Password changed.');
      } catch (ex) { err.textContent = ex.message; }
    });

    // Blocked players
    async function loadBlocks() {
      const box = BH.clear(BH.$('#blocked-list'));
      try {
        const d = await BH.api('/blocks');
        if (!d.blocks.length) { box.append(h('div', { class: 'empty-box', text: 'You have not blocked anyone.' })); return; }
        d.blocks.forEach((b) => box.append(h('div', { class: 'list-row' },
          h('div', {}, h('b', { text: b.displayName }), h('span', { class: 'muted', text: ' @' + b.username })),
          h('button', { class: 'btn ghost small', type: 'button', text: 'Unblock', onclick: async () => {
            try { await BH.api('/blocks/' + encodeURIComponent(b.username), { method: 'DELETE' }); loadBlocks(); } catch (err) { BH.toast(err.message, 'error'); }
          } }))));
      } catch (err) { box.append(h('div', { class: 'empty-box', text: err.message })); }
    }
    loadBlocks();

    // Admin: reports
    if (me.isStaff) {
      BH.$('#admin-section').hidden = false;
      const loadReports = async () => {
        const box = BH.clear(BH.$('#reports-list'));
        try {
          const d = await BH.api('/admin/reports');
          if (!d.reports.length) { box.append(h('div', { class: 'empty-box', text: 'No reports.' })); return; }
          d.reports.forEach((r) => {
            const evidence = r.evidence.map((m) => m.from + ': ' + m.body).join('\n');
            box.append(h('div', { class: 'report-card' },
              h('b', { text: '#' + r.id + ' ' + r.reason + ' \u00B7 ' + r.status }),
              h('div', { class: 'muted', text: '@' + r.reporter + ' reported @' + r.reported + ' \u00B7 ' + BH.ago(r.createdAt) }),
              r.details ? h('p', { text: r.details }) : null,
              evidence ? h('pre', { text: evidence }) : null,
              r.status === 'open' ? h('button', { class: 'btn ghost small', type: 'button', text: 'Mark resolved', onclick: async () => {
                try { await BH.api('/admin/reports/' + r.id, { method: 'PATCH', body: {} }); loadReports(); } catch (err) { BH.toast(err.message, 'error'); }
              } }) : null));
          });
        } catch (err) { box.append(h('div', { class: 'empty-box', text: err.message })); }
      };
      loadReports();
    }

    // Delete account
    BH.$('#delete-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = BH.$('#delete-error');
      err.textContent = '';
      if (!BH.$('#del-confirm').checked) { err.textContent = 'Tick the box to confirm.'; return; }
      try {
        await BH.api('/account', { method: 'DELETE', body: { password: BH.$('#del-password').value } });
        location.href = '/index.html';
      } catch (ex) { err.textContent = ex.message; }
    });
  }

  if (BH.page === 'profile') initProfile();
  if (BH.page === 'settings') initSettings();
})();
