'use strict';
// Contact / problem tickets, and the staff moderation tools (warn, ban, unban) with an audit log.
// "Staff" means the primary administrator (ADMIN_USERNAMES) or the Support account (verified Google email).
const CATEGORIES = {
  general: 'General problem',
  value: 'Incorrect fruit value',
  price: 'Incorrect fruit price',
  trade: 'Trade problem',
  order: 'Store / order problem',
  other: 'Other'
};
const TICKET_STATUSES = ['open', 'in_progress', 'resolved'];
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const ticketCode = (id) => `T-${String(id).padStart(4, '0')}`;

module.exports = function mountSupport(app, ctx) {
  const { db, clean, requireAuth, requireStaff, limiter, logMod, closeStreams, roleOf, userByName } = ctx;
  const ticketLimiter = limiter(60 * 60 * 1000, 5, 'You have sent a lot of tickets. Please wait a while before sending another.');
  const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

  const ticketOut = (r) => ({ id: r.id, code: ticketCode(r.id), category: r.category, categoryLabel: CATEGORIES[r.category] || r.category,
    message: r.message, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at });

  /* ---------------- tickets: users ---------------- */
  app.get('/api/tickets/categories', (req, res) => res.json({ categories: Object.entries(CATEGORIES).map(([key, label]) => ({ key, label })) }));

  app.post('/api/tickets', requireAuth, ticketLimiter, (req, res) => {
    const b = req.body || {};
    const category = typeof b.category === 'string' && Object.hasOwn(CATEGORIES, b.category) ? b.category : null;
    const message = clean(b.message);
    if (!category) return res.status(400).json({ error: 'Choose what your report is about.' });
    if (message.length < 10) return res.status(400).json({ error: 'Please describe the problem in at least 10 characters.' });
    if (message.length > 2000) return res.status(400).json({ error: 'Messages can be up to 2000 characters.' });
    const open = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE user_id = ? AND status != 'resolved'").get(req.user.id).n;
    if (open >= 10) return res.status(429).json({ error: 'You already have 10 unresolved tickets. Please wait for those to be handled.' });
    const id = db.prepare('INSERT INTO tickets (user_id, category, message) VALUES (?, ?, ?)').run(req.user.id, category, message).lastInsertRowid;
    res.status(201).json({ ticket: ticketOut(db.prepare('SELECT * FROM tickets WHERE id = ?').get(id)) });
  });

  app.get('/api/tickets', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM tickets WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
    res.json({ tickets: rows.map(ticketOut) });
  });

  /* ---------------- tickets: staff ---------------- */
  app.get('/api/staff/tickets', requireStaff, (req, res) => {
    const status = TICKET_STATUSES.includes(req.query.status) ? req.query.status : null;
    const rows = db.prepare(`SELECT t.*, u.username FROM tickets t JOIN users u ON u.id = t.user_id
                             ${status ? 'WHERE t.status = ?' : ''}
                             ORDER BY (t.status = 'resolved'), t.id DESC LIMIT 100`).all(...(status ? [status] : []));
    res.json({ tickets: rows.map((r) => ({ ...ticketOut(r), username: r.username })), statuses: TICKET_STATUSES });
  });

  app.patch('/api/staff/tickets/:id', requireStaff, (req, res) => {
    const id = Number(req.params.id);
    const t = Number.isInteger(id) ? db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) : null;
    if (!t) return res.status(404).json({ error: 'Ticket not found.' });
    const status = req.body && req.body.status;
    if (!TICKET_STATUSES.includes(status)) return res.status(400).json({ error: 'Status must be open, in_progress or resolved.' });
    if (status === t.status) return res.json({ ok: true });
    const owner = db.prepare('SELECT id, username FROM users WHERE id = ?').get(t.user_id);
    db.transaction(() => {
      db.prepare(`UPDATE tickets SET status = ?, updated_at = ${NOW} WHERE id = ?`).run(status, t.id);
      logMod(req.user, owner, 'ticket.status', `${ticketCode(t.id)} (${CATEGORIES[t.category] || t.category}): ${t.status} -> ${status}`);
    })();
    res.json({ ok: true });
  });

  /* ---------------- moderation ---------------- */
  // Who may be moderated by whom. Administrators are untouchable; only an administrator can act on the Support account.
  function refuse(actor, target) {
    if (target.id === actor.id) return 'You cannot moderate your own account.';
    const role = roleOf(target);
    if (role.isAdmin) return 'Administrator accounts cannot be moderated.';
    if (role.isSupport && !actor.isAdmin) return 'Only an administrator can moderate the support account.';
    return null;
  }
  function targetFrom(req, res) {
    const name = String(req.params.username || '');
    const target = USERNAME_RE.test(name) ? userByName(name) : null;
    if (!target) { res.status(404).json({ error: 'No player with that username.' }); return null; }
    const why = refuse(req.user, target);
    if (why) { res.status(403).json({ error: why }); return null; }
    return target;
  }
  const reasonOf = (req, { required }) => {
    const reason = clean(req.body && req.body.reason);
    if (required && reason.length < 3) return { error: 'Give a reason (at least 3 characters).' };
    if (reason.length > 300) return { error: 'Reasons can be up to 300 characters.' };
    return { reason };
  };

  app.get('/api/staff/users', requireStaff, (req, res) => {
    const text = clean(String(req.query.q || '')).slice(0, 20);
    const rows = db.prepare(`SELECT u.id, u.username, u.display_name, u.created_at, u.banned, u.ban_reason, u.google_email,
                               (SELECT COUNT(*) FROM warnings w WHERE w.user_id = u.id) AS warnings
                             FROM users u ${text ? "WHERE u.username LIKE ? ESCAPE '\\'" : ''} ORDER BY u.id DESC LIMIT 30`)
      .all(...(text ? [`%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`] : []));
    res.json({ users: rows.map((r) => {
      const role = roleOf(r);
      return { username: r.username, displayName: r.display_name, createdAt: r.created_at, banned: Boolean(r.banned), banReason: r.ban_reason,
        warnings: r.warnings, role: role.isAdmin ? 'admin' : role.isSupport ? 'support' : 'user',
        canModerate: !refuse(req.user, r) };
    }) });
  });

  app.get('/api/staff/users/:username/warnings', requireStaff, (req, res) => {
    const target = targetFrom(req, res);
    if (!target) return;
    const rows = db.prepare(`SELECT w.id, w.reason, w.created_at, m.username AS moderator FROM warnings w
                             LEFT JOIN users m ON m.id = w.moderator_id WHERE w.user_id = ? ORDER BY w.id DESC LIMIT 50`).all(target.id);
    res.json({ warnings: rows.map((r) => ({ id: r.id, reason: r.reason, createdAt: r.created_at, moderator: r.moderator || '(deleted account)' })) });
  });

  app.post('/api/staff/users/:username/warn', requireStaff, (req, res) => {
    const target = targetFrom(req, res);
    if (!target) return;
    const { reason, error } = reasonOf(req, { required: true });
    if (error) return res.status(400).json({ error });
    db.transaction(() => {
      db.prepare('INSERT INTO warnings (user_id, moderator_id, reason) VALUES (?, ?, ?)').run(target.id, req.user.id, reason);
      logMod(req.user, target, 'user.warn', reason);
    })();
    res.status(201).json({ ok: true });
  });

  app.post('/api/staff/users/:username/ban', requireStaff, (req, res) => {
    const target = targetFrom(req, res);
    if (!target) return;
    if (target.banned) return res.status(409).json({ error: 'That player is already banned.' });
    const { reason, error } = reasonOf(req, { required: true });
    if (error) return res.status(400).json({ error });
    db.transaction(() => {
      db.prepare(`UPDATE users SET banned = 1, ban_reason = ?, banned_at = ${NOW} WHERE id = ?`).run(reason, target.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);                       // signed out everywhere, now
      db.prepare("UPDATE trades SET status = 'closed' WHERE user_id = ? AND status = 'open'").run(target.id); // listings stop showing
      logMod(req.user, target, 'user.ban', reason);
    })();
    closeStreams(target.id);
    res.json({ ok: true });
  });

  app.post('/api/staff/users/:username/unban', requireStaff, (req, res) => {
    const target = targetFrom(req, res);
    if (!target) return;
    if (!target.banned) return res.status(409).json({ error: 'That player is not banned.' });
    const { reason, error } = reasonOf(req, { required: false });
    if (error) return res.status(400).json({ error });
    db.transaction(() => {
      db.prepare("UPDATE users SET banned = 0, ban_reason = '', banned_at = NULL WHERE id = ?").run(target.id);
      logMod(req.user, target, 'user.unban', reason || 'No reason given');
    })();
    res.json({ ok: true });
  });

  // The signed-in player's own warnings, so a warning is never a secret from the person who received it.
  app.get('/api/account/warnings', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT id, reason, created_at FROM warnings WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(req.user.id);
    res.json({ warnings: rows.map((r) => ({ id: r.id, reason: r.reason, createdAt: r.created_at })) });
  });

  /* ---------------- audit log (read-only) ---------------- */
  app.get('/api/staff/log', requireStaff, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);
    const rows = db.prepare('SELECT id, moderator_name, target_name, action, details, created_at FROM mod_log ORDER BY id DESC LIMIT ?').all(limit);
    res.json({ log: rows.map((r) => ({ id: r.id, moderator: r.moderator_name, target: r.target_name, action: r.action, details: r.details, createdAt: r.created_at })) });
  });
};
