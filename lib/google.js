'use strict';
// "Sign in with Google" (OAuth 2.0 authorization code + PKCE). Used two ways:
//   link  - a signed-in player connects their Google account in Settings. Google must report the email as
//           verified. If that email is listed in SUPPORT_EMAILS the account becomes the Support account.
//   login - a player whose Google account is already linked signs in with it.
// No Gmail password is ever seen or stored. Only Google's stable user id (sub) and verified email are kept.
const crypto = require('crypto');

module.exports = function mountGoogle(app, ctx) {
  const { db, requireAuth, startSession, fetchJson, roleOf, supportEmails, BASE_URL } = ctx;
  const cfg = {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || `${BASE_URL}/api/auth/google/callback`
  };
  const enabled = Boolean(cfg.clientId && cfg.clientSecret);
  ctx.googleEnabled = enabled;

  app.get('/api/auth/google/start', (req, res) => {
    const mode = req.query.mode === 'login' ? 'login' : 'link';
    if (mode === 'link' && !req.user) return res.redirect('/login.html?next=%2Fsettings.html');
    if (mode === 'login' && req.user) return res.redirect('/index.html');
    if (!enabled) return res.redirect(mode === 'link' ? '/settings.html?google=unavailable' : '/login.html?google=unavailable');
    const state = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM google_states WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO google_states (state, mode, user_id, code_verifier, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(state, mode, req.user ? req.user.id : null, verifier, Date.now() + 10 * 60 * 1000);
    const params = new URLSearchParams({
      client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: 'openid email profile',
      state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account'
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get('/api/auth/google/callback', async (req, res, next) => {
    try {
      const { code, state, error } = req.query;
      const row = typeof state === 'string' ? db.prepare('SELECT * FROM google_states WHERE state = ?').get(state) : null;
      if (row) db.prepare('DELETE FROM google_states WHERE state = ?').run(state); // one-time use
      const link = row ? row.mode === 'link' : false;
      const back = (c) => res.redirect(`${link ? '/settings.html' : '/login.html'}?google=${c}`);
      if (!enabled) return back('unavailable');
      if (error || typeof code !== 'string' || !row || row.expires_at < Date.now()) return back(error ? 'cancelled' : 'error');
      // The browser that finished the flow must be the one that started it.
      if (link && (!req.user || req.user.id !== row.user_id)) return back('error');
      if (!link && req.user) return res.redirect('/index.html');

      let info;
      try {
        const token = await fetchJson('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: row.code_verifier })
        });
        info = await fetchJson('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } });
      } catch (e) { console.error('Google OAuth failed:', e.message); return back('error'); }
      // Only a verified email counts. Without this check anyone could claim an address they do not own.
      if (!info || typeof info.sub !== 'string' || typeof info.email !== 'string' || info.email_verified !== true) return back('unverified');
      const email = info.email.trim().toLowerCase();

      if (!link) {
        const user = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(info.sub);
        if (!user) return back('unlinked');
        if (user.banned) return back('banned');
        startSession(res, user.id);
        const r = roleOf(user);
        return res.redirect(r.isAdmin || r.isSupport ? "/staff.html" : "/index.html");
      }

      // The Support email must belong to a separate account from the primary administrator.
      const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      if (supportEmails.has(email) && roleOf(me).isAdmin) return back('adminconflict');
      try {
        db.prepare('UPDATE users SET google_sub = ?, google_email = ? WHERE id = ?').run(info.sub, email, me.id);
      } catch (e) {
        if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return back('taken');
        throw e;
      }
      return back('connected');
    } catch (e) { next(e); }
  });

  app.post('/api/auth/google/disconnect', requireAuth, (req, res) => {
    db.prepare('UPDATE users SET google_sub = NULL, google_email = NULL WHERE id = ?').run(req.user.id);
    res.json({ ok: true });
  });
};
