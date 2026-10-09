'use strict';
require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./lib/db');
const { hasBadWord } = require('./lib/badwords');
const images = require('./lib/images');
const payments = require('./lib/payments');
const mountGoogle = require('./lib/google');
const mountStore = require('./lib/store');
const mountSupport = require('./lib/support');

const scrypt = promisify(crypto.scrypt);

/* ==========================================================================
   Configuration (everything secret comes from environment variables)
   ========================================================================== */
const PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMINS = new Set((process.env.ADMIN_USERNAMES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const ROBLOX = {
  clientId: process.env.ROBLOX_CLIENT_ID || '',
  clientSecret: process.env.ROBLOX_CLIENT_SECRET || '',
  redirectUri: process.env.ROBLOX_REDIRECT_URI || `${BASE_URL}/api/auth/roblox/callback`
};
ROBLOX.enabled = Boolean(ROBLOX.clientId && ROBLOX.clientSecret);
// Support / moderator accounts are identified by a Google-VERIFIED email (never by what someone types at sign-up).
// Unset means the default below; set SUPPORT_EMAILS= (empty) to switch the support role off.
const SUPPORT_EMAILS = new Set((process.env.SUPPORT_EMAILS === undefined ? 'bloxfruitharbour.support@gmail.com' : process.env.SUPPORT_EMAILS)
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const SCRYPT_OPTS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${crypto.scryptSync('not-a-real-password', Buffer.alloc(16), 64, SCRYPT_OPTS).toString('hex')}`;

/* ==========================================================================
   Prepared statements
   ========================================================================== */
const q = {
  session: db.prepare(`SELECT u.id, u.username, u.display_name, u.google_email, u.banned, s.expires_at
                       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`),
  insSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insUser: db.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)'),
  item: db.prepare('SELECT * FROM items WHERE id = ?'),
  itemExists: db.prepare('SELECT 1 FROM items WHERE id = ?'),
  insItem: db.prepare(`INSERT INTO items (name, category, type, rarity, value, demand, trend, price_beli, base_fruit, notes, image_url)
                       VALUES (@name, @category, @type, @rarity, @value, @demand, @trend, @price_beli, @base_fruit, @notes, @image_url)`),
  updItem: db.prepare(`UPDATE items SET name=@name, category=@category, type=@type, rarity=@rarity, value=@value, demand=@demand,
                       trend=@trend, price_beli=@price_beli, base_fruit=@base_fruit, notes=@notes, image_url=@image_url, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=@id`),
  delItem: db.prepare('DELETE FROM items WHERE id = ?'),
  insHist: db.prepare('INSERT INTO value_history (item_id, item_name, old_value, new_value, changed_by) VALUES (?, ?, ?, ?, ?)'),
  convById: db.prepare('SELECT * FROM conversations WHERE id = ? AND (user_a = ? OR user_b = ?)'),
  convByPair: db.prepare('SELECT * FROM conversations WHERE user_a = ? AND user_b = ?'),
  insConv: db.prepare('INSERT INTO conversations (user_a, user_b, created_by) VALUES (?, ?, ?)'),
  insMsg: db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)'),
  msgById: db.prepare('SELECT id, sender_id, body, created_at FROM messages WHERE id = ?'),
  msgsLast: db.prepare('SELECT id, sender_id, body, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 100'),
  msgsAfter: db.prepare('SELECT id, sender_id, body, created_at FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT 200'),
  lastMsgId: db.prepare('SELECT MAX(id) AS m FROM messages WHERE conversation_id = ?'),
  upsertRead: db.prepare(`INSERT INTO reads (conversation_id, user_id, last_read_id) VALUES (?, ?, ?)
                          ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`),
  blockedEither: db.prepare(`SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`),
  unread: db.prepare(`SELECT COUNT(*) AS n FROM messages m
                      JOIN conversations c ON c.id = m.conversation_id
                      LEFT JOIN reads r ON r.conversation_id = c.id AND r.user_id = @me
                      WHERE (c.user_a = @me OR c.user_b = @me) AND m.sender_id != @me AND m.id > COALESCE(r.last_read_id, 0)`),
  tradeStats: db.prepare(`SELECT COUNT(*) AS total,
                          COALESCE(SUM(status = 'open'), 0) AS open,
                          COALESCE(SUM(status = 'closed'), 0) AS closed FROM trades WHERE user_id = ?`)
};

/* ==========================================================================
   Helpers
   ========================================================================== */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const round4 = (n) => Math.round(n * 10000) / 10000; // values are in millions; 5K = 0.005

// Removes control characters and invisible direction/format tricks, normalises line breaks.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
function clean(v) {
  if (typeof v !== 'string') return '';
  return v.normalize('NFC').replace(UNSAFE_CHARS, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 1) return;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
  });
  return out;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT_OPTS);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT_OPTS);
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.insSession.run(sha(token), userId, Date.now() + SESSION_MS);
  res.cookie('bh_sid', token, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: SESSION_MS, path: '/' });
}

function validateNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 128) return 'Password must be 128 characters or fewer.';
  return null;
}

// The primary administrator and the Support account are always different accounts: an administrator is never "support".
function roleOf(row) {
  const isAdmin = ADMINS.has(String(row.username).toLowerCase());
  const isSupport = !isAdmin && Boolean(row.google_email) && SUPPORT_EMAILS.has(String(row.google_email).toLowerCase());
  return { isAdmin, isSupport };
}
function sessionUser(row) {
  const { isAdmin, isSupport } = roleOf(row);
  return { id: row.id, username: row.username, displayName: row.display_name, isAdmin, isSupport, isStaff: isAdmin || isSupport };
}

// Every moderation or staff action goes through here: who did it, to whom, what, and (automatically) when.
const insLog = db.prepare('INSERT INTO mod_log (moderator_id, moderator_name, target_user_id, target_name, action, details) VALUES (?, ?, ?, ?, ?, ?)');
function logMod(actor, target, action, details = '') {
  insLog.run(actor.id, actor.username, target ? target.id : null, target ? target.username : '', action, String(details).slice(0, 500));
}

const validRbxAvatar = (u) => {
  try { const x = new URL(u); return x.protocol === 'https:' && x.hostname.endsWith('.rbxcdn.com'); } catch { return false; }
};

function robloxInfo(u, { self = false } = {}) {
  if (!u.roblox_id) return null;
  if (!u.show_roblox && !self) return null;
  return {
    id: u.roblox_id,
    username: u.roblox_username,
    displayName: u.roblox_display_name,
    avatarUrl: u.roblox_avatar_url && validRbxAvatar(u.roblox_avatar_url) ? u.roblox_avatar_url : null,
    profileUrl: `https://www.roblox.com/users/${encodeURIComponent(u.roblox_id)}/profile`,
    hidden: !u.show_roblox
  };
}

/* ==========================================================================
   Middleware
   ========================================================================== */
function loadUser(req, res, next) {
  req.user = null;
  const token = parseCookies(req.headers.cookie).bh_sid;
  if (token) {
    const hash = sha(token);
    const row = q.session.get(hash);
    if (row) {
      if (row.expires_at < Date.now() || row.banned) q.delSession.run(hash);
      else req.user = { ...sessionUser(row), tokenHash: hash };
    }
  }
  next();
}
const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please log in to continue.' }));
const requireStaff = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  if (!req.user.isStaff) return res.status(403).json({ error: 'Staff access required.' });
  next();
};
const requireAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  next();
};

// State-changing API calls must come from our own pages: custom header + same-origin check.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const blocked = () => res.status(403).json({ error: 'Request blocked.' });
  if (req.get('x-bh-csrf') !== '1') return blocked();
  const origin = req.get('origin');
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) return blocked(); } catch { return blocked(); }
  }
  next();
}

const limitMsg = (message) => ({ error: message });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false, message: limitMsg('Too many requests. Slow down a little.') });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: limitMsg('Too many attempts. Try again in a few minutes.') });
const userKey = (req) => `u${req.user ? req.user.id : 'anon'}`;
const messageLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, keyGenerator: userKey, standardHeaders: true, legacyHeaders: false, message: limitMsg('You are sending messages too fast. Wait a moment.') });
const newChatLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, keyGenerator: userKey, standardHeaders: true, legacyHeaders: false, message: limitMsg('You have started too many chats. Try again later.') });
const reportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, keyGenerator: userKey, standardHeaders: true, legacyHeaders: false, message: limitMsg('Too many reports. Try again later.') });
const mkLimiter = (windowMs, limit, message) => rateLimit({ windowMs, limit, keyGenerator: userKey, standardHeaders: true, legacyHeaders: false, message: limitMsg(message) });
const imgLimiter = rateLimit({ windowMs: 60 * 1000, limit: 900, standardHeaders: true, legacyHeaders: false });
const listingLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, keyGenerator: userKey, standardHeaders: true, legacyHeaders: false, message: limitMsg('You are posting too many listings. Try again later.') });

/* ==========================================================================
   App setup
   ========================================================================== */
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
}

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'https://*.rbxcdn.com'],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'upgrade-insecure-requests': PROD ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use('/api', express.json({ limit: '20kb' }));
app.use(['/api', '/chat.html', '/settings.html', '/profile.html', '/staff.html'], loadUser);
app.use('/api', csrfGuard);
app.use('/api', apiLimiter);

// Pages that need a session. Public profiles (profile.html?u=name) stay public.
app.get(['/chat.html', '/settings.html', '/profile.html'], (req, res, next) => {
  const publicProfile = req.path.toLowerCase() === '/profile.html' && req.query.u;
  if (!req.user && !publicProfile) return res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
  next();
});

// Staff panel page: staff only (the data behind it is protected separately by the API).
app.get('/staff.html', (req, res, next) => {
  if (!req.user) return res.redirect('/login.html?next=%2Fstaff.html');
  if (!req.user.isStaff) return res.redirect('/index.html');
  next();
});

// Fruit images are served from our own cache (see lib/images.js). Unknown item: 404. No image yet: generic icon.
const FALLBACK_IMG = path.join(__dirname, 'public', 'assets', 'images', 'fruit-fallback.svg');
app.get('/img/fruit/:id', imgLimiter, ah(async (req, res) => {
  const id = Number(req.params.id);
  const item = Number.isInteger(id) ? q.item.get(id) : null;
  if (!item) return res.status(404).end();
  let img = await images.forItem(item);
  if (!img && item.base_fruit) img = await images.forItem(db.prepare('SELECT * FROM items WHERE name = ?').get(item.base_fruit));
  if (!img) { res.set('Cache-Control', 'public, max-age=300'); return res.sendFile(FALLBACK_IMG, { dotfiles: 'allow' }); }
  res.set('Cache-Control', 'public, max-age=86400');
  res.type(img.type).sendFile(img.file, { dotfiles: 'allow' });
}));

app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'ignore', maxAge: PROD ? '1h' : 0 }));

/* ==========================================================================
   Auth
   ========================================================================== */
app.post('/api/auth/register', authLimiter, ah(async (req, res) => {
  const username = clean(req.body && req.body.username);
  let displayName = clean(req.body && req.body.displayName) || username;
  const password = req.body && req.body.password;
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 3 to 20 letters, numbers or underscores.' });
  if (displayName.length > 30) return res.status(400).json({ error: 'Display name can be up to 30 characters.' });
  const pwError = validateNewPassword(password);
  if (pwError) return res.status(400).json({ error: pwError });
  if (q.userByName.get(username)) return res.status(409).json({ error: 'That username is already taken.' });

  const hash = await hashPassword(password);
  let id;
  try { id = q.insUser.run(username, displayName, hash).lastInsertRowid; } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'That username is already taken.' });
    throw e;
  }
  if (req.user) q.delSession.run(req.user.tokenHash);
  startSession(res, id);
  res.status(201).json({ user: sessionUser(q.userById.get(id)) });
}));

app.post('/api/auth/login', authLimiter, ah(async (req, res) => {
  const username = clean(req.body && req.body.username);
  const password = req.body && req.body.password;
  const user = typeof password === 'string' && USERNAME_RE.test(username) ? q.userByName.get(username) : null;
  const ok = await verifyPassword(typeof password === 'string' ? password : '', user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Incorrect username or password.' });
  if (user.banned) return res.status(403).json({ error: `This account has been suspended${user.ban_reason ? `: ${user.ban_reason}` : '.'}` });
  if (req.user) q.delSession.run(req.user.tokenHash);
  startSession(res, user.id);
  res.json({ user: sessionUser(user) });
}));

app.post('/api/auth/logout', (req, res) => {
  if (req.user) q.delSession.run(req.user.tokenHash);
  res.clearCookie('bh_sid', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = req.user ? { id: req.user.id, username: req.user.username, displayName: req.user.displayName, isAdmin: req.user.isAdmin, isSupport: req.user.isSupport, isStaff: req.user.isStaff } : null;
  res.json({ user, robloxEnabled: ROBLOX.enabled, googleEnabled: Boolean(ctx.googleEnabled) });
});

/* ---- Roblox: official OAuth 2.0 (authorization code + PKCE). No passwords, no tokens stored. ---- */
async function fetchJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);
  return r.json();
}

app.get('/api/auth/roblox/start', (req, res) => {
  if (!req.user) return res.redirect('/login.html?next=%2Fsettings.html');
  if (!ROBLOX.enabled) return res.redirect('/settings.html?roblox=unavailable');
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO oauth_states (state, user_id, code_verifier, expires_at) VALUES (?, ?, ?, ?)')
    .run(state, req.user.id, verifier, Date.now() + 10 * 60 * 1000);
  const params = new URLSearchParams({
    client_id: ROBLOX.clientId,
    redirect_uri: ROBLOX.redirectUri,
    scope: 'openid profile',
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  res.redirect(`https://apis.roblox.com/oauth/v1/authorize?${params}`);
});

app.get('/api/auth/roblox/callback', ah(async (req, res) => {
  if (!req.user) return res.redirect('/login.html?next=%2Fsettings.html');
  const back = (code) => res.redirect(`/settings.html?roblox=${code}`);
  if (!ROBLOX.enabled) return back('unavailable');
  const { code, state, error } = req.query;
  if (error || typeof code !== 'string' || typeof state !== 'string') return back('cancelled');

  const row = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
  if (row) db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state); // one-time use
  if (!row || row.user_id !== req.user.id || row.expires_at < Date.now()) return back('error');

  try {
    const token = await fetchJson('https://apis.roblox.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: ROBLOX.redirectUri,
        client_id: ROBLOX.clientId,
        client_secret: ROBLOX.clientSecret,
        code_verifier: row.code_verifier
      })
    });
    const info = await fetchJson('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    const robloxId = String(info.sub || '');
    if (!/^\d{1,20}$/.test(robloxId)) return back('error');

    let avatar = typeof info.picture === 'string' && validRbxAvatar(info.picture) ? info.picture : null;
    if (!avatar) {
      try {
        const t = await fetchJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxId}&size=150x150&format=Png&isCircular=false`);
        const url = t && t.data && t.data[0] && t.data[0].imageUrl;
        if (url && validRbxAvatar(url)) avatar = url;
      } catch { /* avatar is optional */ }
    }

    try {
      db.prepare(`UPDATE users SET roblox_id = ?, roblox_username = ?, roblox_display_name = ?, roblox_avatar_url = ? WHERE id = ?`)
        .run(robloxId, clean(String(info.preferred_username || '')).slice(0, 40), clean(String(info.name || info.nickname || '')).slice(0, 40), avatar, req.user.id);
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return back('taken');
      throw e;
    }
    // The access token is discarded here on purpose. We only need to know who the player is.
    return back('connected');
  } catch (e) {
    console.error('Roblox OAuth failed:', e.message);
    return back('error');
  }
}));

app.post('/api/auth/roblox/disconnect', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET roblox_id = NULL, roblox_username = NULL, roblox_display_name = NULL, roblox_avatar_url = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

/* ==========================================================================
   Values
   ========================================================================== */
const SORTS = {
  value_desc: 'value DESC, name ASC',
  value_asc: 'value ASC, name ASC',
  name: 'name ASC',
  demand: 'demand DESC, value DESC',
  updated: 'updated_at DESC, name ASC'
};
const TRENDS = ['rising', 'stable', 'falling'];

const itemOut = (r) => ({
  id: r.id, name: r.name, category: r.category, type: r.type, rarity: r.rarity, value: r.value,
  demand: r.demand, trend: r.trend, priceBeli: r.price_beli, baseFruit: r.base_fruit, notes: r.notes, updatedAt: r.updated_at,
  priceNpr: r.price_npr, stock: r.stock, imageUrl: r.image_url
});

app.get('/api/values', (req, res) => {
  const where = [];
  const params = {};
  const text = clean(String(req.query.q || '')).slice(0, 40);
  if (text) {
    where.push("(name LIKE @q ESCAPE '\\' OR type LIKE @q ESCAPE '\\')");
    params.q = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  }
  if (req.query.category) { where.push('category = @category'); params.category = clean(String(req.query.category)).slice(0, 30); }
  if (req.query.rarity) { where.push('rarity = @rarity'); params.rarity = clean(String(req.query.rarity)).slice(0, 20); }
  const order = typeof req.query.sort === 'string' && Object.hasOwn(SORTS, req.query.sort) ? SORTS[req.query.sort] : SORTS.value_desc;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  const sql = `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${limit}`;
  const items = db.prepare(sql).all(params).map(itemOut);
  const categories = db.prepare('SELECT DISTINCT category FROM items ORDER BY category').all().map((r) => r.category);
  const rarities = db.prepare('SELECT DISTINCT rarity FROM items ORDER BY rarity').all().map((r) => r.rarity);
  res.json({ items, categories, rarities });
});

app.get('/api/values/updates', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
  const rows = db.prepare(`SELECT h.item_id, h.item_name, h.old_value, h.new_value, h.changed_at, i.rarity
                           FROM value_history h LEFT JOIN items i ON i.id = h.item_id
                           ORDER BY h.id DESC LIMIT ?`).all(limit);
  res.json({ updates: rows.map((r) => ({ itemId: r.item_id, name: r.item_name, oldValue: r.old_value, newValue: r.new_value, changedAt: r.changed_at, rarity: r.rarity || '' })) });
});

// Only real numbers or non-empty numeric strings count; null, '', booleans and arrays become NaN
// (Number(null) is 0, which would silently save an empty value as 0).
const toNum = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);

function parseItem(body) {
  const b = body || {};
  const name = clean(b.name);
  const category = clean(b.category) || 'Fruit';
  const type = clean(b.type);
  const rarity = clean(b.rarity) || 'Common';
  const value = toNum(b.value);
  const demand = toNum(b.demand);
  const trend = String(b.trend || 'stable');
  const notes = clean(b.notes);
  const baseFruit = clean(b.baseFruit);
  const imageUrl = clean(b.imageUrl);
  const price = b.priceBeli === '' || b.priceBeli === null || b.priceBeli === undefined ? null : toNum(b.priceBeli);
  if (!name || name.length > 40) return { error: 'Name is required (40 characters max).' };
  if (category.length > 30 || type.length > 20 || rarity.length > 20) return { error: 'Category, type or rarity is too long.' };
  if (!Number.isFinite(value) || value < 0 || value > 1000000) return { error: 'Value must be a number from 0 to 1,000,000 (in millions).' };
  if (!Number.isInteger(demand) || demand < 1 || demand > 10) return { error: 'Demand must be a whole number from 1 to 10.' };
  if (!TRENDS.includes(trend)) return { error: 'Trend must be rising, stable or falling.' };
  if (price !== null && (!Number.isInteger(price) || price < 0 || price > 1e12)) return { error: 'Beli price must be a whole number or empty.' };
  if (notes.length > 200) return { error: 'Notes can be up to 200 characters.' };
  if (baseFruit.length > 40) return { error: 'Base fruit can be up to 40 characters.' };
  if (imageUrl && (imageUrl.length > 500 || !images.allowed(imageUrl))) return { error: 'Image URL must be an https link on the Blox Fruits wiki or Roblox (leave empty to find one automatically).' };
  return { data: { name, category, type, rarity, value: round4(value), demand, trend, price_beli: price, base_fruit: baseFruit, notes, image_url: imageUrl } };
}

app.post('/api/values', requireAdmin, (req, res) => {
  const { error, data } = parseItem(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const id = db.transaction(() => {
      const newId = q.insItem.run(data).lastInsertRowid;
      q.insHist.run(newId, data.name, null, data.value, req.user.id);
      return newId;
    })();
    setImmediate(() => images.warm([q.item.get(id)]).catch(() => {})); // fetch the new item's picture in the background
    res.status(201).json({ id });
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'An item with that name already exists.' });
    throw e;
  }
});

app.put('/api/values/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const old = Number.isInteger(id) ? q.item.get(id) : null;
  if (!old) return res.status(404).json({ error: 'Item not found.' });
  const { error, data } = parseItem(req.body);
  if (error) return res.status(400).json({ error });
  try {
    db.transaction(() => {
      q.updItem.run({ ...data, id });
      if (old.name !== data.name || old.image_url !== data.image_url) images.clear(id, old.name); // look the image up again
      if (old.value !== data.value) q.insHist.run(id, data.name, old.value, data.value, req.user.id);
    })();
    res.json({ ok: true });
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'An item with that name already exists.' });
    throw e;
  }
});

app.delete('/api/values/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !q.itemExists.get(id)) return res.status(404).json({ error: 'Item not found.' });
  q.delItem.run(id);
  images.clear(id);
  res.json({ ok: true });
});

/* ==========================================================================
   Trade listings
   ========================================================================== */
function hydrateTrades(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const items = db.prepare(`SELECT ti.trade_id, ti.side, ti.qty, i.id AS item_id, i.name, i.rarity, i.value
                            FROM trade_items ti JOIN items i ON i.id = ti.item_id
                            WHERE ti.trade_id IN (${ids.map(() => '?').join(',')}) ORDER BY i.value DESC`).all(...ids);
  const map = new Map(rows.map((r) => [r.id, {
    id: r.id, note: r.note, status: r.status, createdAt: r.created_at,
    user: { username: r.username, displayName: r.display_name, avatarUrl: r.show_roblox && r.roblox_avatar_url && validRbxAvatar(r.roblox_avatar_url) ? r.roblox_avatar_url : null },
    have: [], want: [], valueHave: 0, valueWant: 0
  }]));
  for (const it of items) {
    const t = map.get(it.trade_id);
    const side = it.side === 'have' ? 'have' : 'want';
    t[side].push({ itemId: it.item_id, name: it.name, rarity: it.rarity, qty: it.qty, value: it.value });
    const key = side === 'have' ? 'valueHave' : 'valueWant';
    t[key] = round4(t[key] + it.value * it.qty);
  }
  return rows.map((r) => map.get(r.id));
}

const TRADE_SELECT = `SELECT t.id, t.note, t.status, t.created_at, u.username, u.display_name, u.roblox_avatar_url, u.show_roblox
                      FROM trades t JOIN users u ON u.id = t.user_id`;

app.get('/api/trades', (req, res) => {
  const where = [];
  const params = {};
  if (req.query.mine === '1') {
    if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
    where.push('t.user_id = @me');
    params.me = req.user.id;
  } else {
    where.push("t.status = 'open'");
  }
  const text = clean(String(req.query.q || '')).slice(0, 40);
  if (text) {
    where.push(`EXISTS (SELECT 1 FROM trade_items ti JOIN items i ON i.id = ti.item_id WHERE ti.trade_id = t.id AND i.name LIKE @q ESCAPE '\\')`);
    params.q = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  }
  const rows = db.prepare(`${TRADE_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT 50`).all(params);
  res.json({ trades: hydrateTrades(rows) });
});

function parseTradeSide(arr) {
  if (!Array.isArray(arr) || arr.length < 1 || arr.length > 8) return null;
  const seen = new Set();
  const out = [];
  for (const e of arr) {
    const itemId = Number(e && e.itemId);
    const qty = Number(e && e.qty);
    if (!Number.isInteger(itemId) || !Number.isInteger(qty) || qty < 1 || qty > 99 || seen.has(itemId) || !q.itemExists.get(itemId)) return null;
    seen.add(itemId);
    out.push({ itemId, qty });
  }
  return out;
}

app.post('/api/trades', requireAuth, listingLimiter, (req, res) => {
  const have = parseTradeSide(req.body && req.body.have);
  const want = parseTradeSide(req.body && req.body.want);
  const note = clean(req.body && req.body.note);
  if (!have || !want) return res.status(400).json({ error: 'Add 1 to 8 different fruits to each side, with quantities from 1 to 99.' });
  if (note.length > 200) return res.status(400).json({ error: 'Notes can be up to 200 characters.' });
  const open = db.prepare("SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND status = 'open'").get(req.user.id).n;
  if (open >= 10) return res.status(400).json({ error: 'You already have 10 open listings. Close one before posting another.' });

  const id = db.transaction(() => {
    const tid = db.prepare('INSERT INTO trades (user_id, note) VALUES (?, ?)').run(req.user.id, note).lastInsertRowid;
    const ins = db.prepare('INSERT INTO trade_items (trade_id, item_id, side, qty) VALUES (?, ?, ?, ?)');
    have.forEach((e) => ins.run(tid, e.itemId, 'have', e.qty));
    want.forEach((e) => ins.run(tid, e.itemId, 'want', e.qty));
    return tid;
  })();
  res.status(201).json({ id });
});

function ownTrade(req, res) {
  const id = Number(req.params.id);
  const t = Number.isInteger(id) ? db.prepare('SELECT * FROM trades WHERE id = ?').get(id) : null;
  if (!t) { res.status(404).json({ error: 'Listing not found.' }); return null; }
  if (t.user_id !== req.user.id && !req.user.isAdmin) { res.status(403).json({ error: 'You can only change your own listings.' }); return null; }
  return t;
}

app.patch('/api/trades/:id', requireAuth, (req, res) => {
  const t = ownTrade(req, res);
  if (!t) return;
  const status = req.body && req.body.status;
  if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Status must be open or closed.' });
  db.prepare('UPDATE trades SET status = ? WHERE id = ?').run(status, t.id);
  res.json({ ok: true });
});

app.delete('/api/trades/:id', requireAuth, (req, res) => {
  const t = ownTrade(req, res);
  if (!t) return;
  db.prepare('DELETE FROM trades WHERE id = ?').run(t.id);
  res.json({ ok: true });
});

/* ==========================================================================
   Profiles and account
   ========================================================================== */
function buildProfile(u, { self = false } = {}) {
  const stats = q.tradeStats.get(u.id);
  const rows = db.prepare(`${TRADE_SELECT} WHERE t.user_id = ? ${self ? '' : "AND t.status = 'open'"} ORDER BY t.id DESC LIMIT 20`).all(u.id);
  return {
    profile: {
      username: u.username,
      displayName: u.display_name,
      bio: u.bio,
      createdAt: u.created_at,
      roblox: robloxInfo(u, { self }),
      showRoblox: Boolean(u.show_roblox),
      isSelf: self
    },
    account: self ? { googleEmail: u.google_email || null } : undefined,
    stats: { total: stats.total, open: stats.open, closed: stats.closed },
    listings: hydrateTrades(rows)
  };
}

app.get('/api/profile/me', requireAuth, (req, res) => {
  res.json(buildProfile(q.userById.get(req.user.id), { self: true }));
});

app.patch('/api/profile/me', requireAuth, (req, res) => {
  const b = req.body || {};
  const displayName = clean(b.displayName);
  const bio = clean(b.bio);
  if (!displayName || displayName.length > 30) return res.status(400).json({ error: 'Display name is required (30 characters max).' });
  if (bio.length > 200) return res.status(400).json({ error: 'Bio can be up to 200 characters.' });
  db.prepare('UPDATE users SET display_name = ?, bio = ?, show_roblox = ? WHERE id = ?').run(displayName, bio, b.showRoblox ? 1 : 0, req.user.id);
  res.json({ ok: true });
});

app.get('/api/users/:username', (req, res) => {
  const name = String(req.params.username);
  const u = USERNAME_RE.test(name) ? q.userByName.get(name) : null;
  if (!u || (u.banned && !(req.user && req.user.isStaff))) return res.status(404).json({ error: 'No player with that username.' });
  res.json(buildProfile(u, { self: Boolean(req.user && req.user.id === u.id) }));
});

app.post('/api/account/password', requireAuth, authLimiter, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const u = q.userById.get(req.user.id);
  if (typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, u.password_hash))) {
    return res.status(400).json({ error: 'Your current password is not correct.' });
  }
  const pwError = validateNewPassword(newPassword);
  if (pwError) return res.status(400).json({ error: pwError });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(newPassword), u.id);
  q.delUserSessions.run(u.id); // sign out everywhere, then keep this device signed in
  closeStreams(u.id); // other devices lose their live connection; this one reconnects with the new cookie
  startSession(res, u.id);
  res.json({ ok: true });
}));

app.delete('/api/account', requireAuth, authLimiter, ah(async (req, res) => {
  const u = q.userById.get(req.user.id);
  const pw = req.body && req.body.password;
  if (typeof pw !== 'string' || !(await verifyPassword(pw, u.password_hash))) {
    return res.status(400).json({ error: 'Your password is not correct.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  closeStreams(u.id);
  res.clearCookie('bh_sid', { path: '/' });
  res.json({ ok: true });
}));

/* ==========================================================================
   Private chat
   ========================================================================== */
const streams = new Map(); // userId -> Set(res) for server-sent events
function pushTo(userId, event, data) {
  const set = streams.get(userId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of set) r.write(payload);
}

// Ends every open live-update stream of a user (used when their sessions are revoked).
function closeStreams(userId) {
  const set = streams.get(userId);
  if (!set) return;
  streams.delete(userId);
  for (const r of set) r.end();
}

// Returns the conversation only if the user is one of its two participants.
function getConversation(rawId, userId) {
  const id = Number(rawId);
  if (!Number.isInteger(id)) return null;
  return q.convById.get(id, userId, userId) || null;
}
const otherOf = (conv, me) => (conv.user_a === me ? conv.user_b : conv.user_a);
const isBlocked = (a, b) => Boolean(q.blockedEither.get(a, b, b, a));
const msgOut = (m) => ({ id: m.id, senderId: m.sender_id, body: m.body, createdAt: m.created_at });
const chatUser = (u) => ({ username: u.username, displayName: u.display_name, avatarUrl: u.show_roblox && u.roblox_avatar_url && validRbxAvatar(u.roblox_avatar_url) ? u.roblox_avatar_url : null });

app.get('/api/chat/unread', requireAuth, (req, res) => {
  res.json({ unread: q.unread.get({ me: req.user.id }).n });
});

app.get('/api/chat/conversations', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, u.username, u.display_name, u.roblox_avatar_url, u.show_roblox,
      (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_body,
      (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_at,
      (SELECT sender_id FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_sender,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != @me AND m.id > COALESCE(r.last_read_id, 0)) AS unread,
      EXISTS (SELECT 1 FROM blocks WHERE blocker_id = @me AND blocked_id = u.id) AS blocked_by_me,
      c.created_at
    FROM conversations c
    JOIN users u ON u.id = CASE WHEN c.user_a = @me THEN c.user_b ELSE c.user_a END
    LEFT JOIN reads r ON r.conversation_id = c.id AND r.user_id = @me
    WHERE (c.user_a = @me OR c.user_b = @me)
      AND (c.created_by = @me OR EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id))
    ORDER BY COALESCE(last_at, c.created_at) DESC`).all({ me: req.user.id });
  res.json({
    conversations: rows.map((r) => ({
      id: r.id,
      other: chatUser(r),
      lastMessage: r.last_body,
      lastAt: r.last_at,
      lastFromMe: r.last_sender === req.user.id,
      unread: r.unread,
      blockedByMe: Boolean(r.blocked_by_me)
    }))
  });
});

app.post('/api/chat/conversations', requireAuth, newChatLimiter, (req, res) => {
  const name = clean(req.body && req.body.username);
  const other = USERNAME_RE.test(name) ? q.userByName.get(name) : null;
  if (!other || other.banned) return res.status(404).json({ error: 'No player with that username.' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'You cannot start a chat with yourself.' });
  if (isBlocked(req.user.id, other.id)) return res.status(403).json({ error: "You can't start a conversation with this user." });
  const a = Math.min(req.user.id, other.id);
  const b = Math.max(req.user.id, other.id);
  let conv = q.convByPair.get(a, b);
  if (!conv) {
    try { q.insConv.run(a, b, req.user.id); } catch { /* created at the same moment by the other side */ }
    conv = q.convByPair.get(a, b);
  }
  res.status(201).json({ id: conv.id });
});

app.get('/api/chat/conversations/:id/messages', requireAuth, (req, res) => {
  const conv = getConversation(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
  const after = parseInt(req.query.after, 10) || 0;
  const rows = after > 0 ? q.msgsAfter.all(conv.id, after) : q.msgsLast.all(conv.id).reverse();
  const other = q.userById.get(otherOf(conv, req.user.id));
  res.json({
    messages: rows.map(msgOut),
    other: chatUser(other),
    blockedByMe: Boolean(db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(req.user.id, other.id))
  });
});

app.post('/api/chat/conversations/:id/messages', requireAuth, messageLimiter, (req, res) => {
  const conv = getConversation(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
  const body = clean(req.body && req.body.body);
  if (!body) return res.status(400).json({ error: 'Write a message first.' });
  if (body.length > 1000) return res.status(400).json({ error: 'Messages can be up to 1000 characters.' });
  const otherId = otherOf(conv, req.user.id);
  if (isBlocked(req.user.id, otherId) || q.userById.get(otherId).banned) return res.status(403).json({ error: "This message can't be sent." });
  // Bad-word filter: clean messages continue, flagged ones are rejected before they are stored or delivered.
  if (hasBadWord(body)) return res.status(422).json({ error: 'Message not sent: it contains language that is not allowed here. Please keep chat friendly.' });

  const message = msgOut(q.msgById.get(q.insMsg.run(conv.id, req.user.id, body).lastInsertRowid));
  const payload = { conversationId: conv.id, message };
  pushTo(otherId, 'message', payload);
  pushTo(req.user.id, 'message', payload); // keeps the sender's other tabs in sync
  res.status(201).json(message);
});

app.post('/api/chat/conversations/:id/read', requireAuth, (req, res) => {
  const conv = getConversation(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
  q.upsertRead.run(conv.id, req.user.id, q.lastMsgId.get(conv.id).m || 0);
  res.json({ ok: true });
});

app.get('/api/chat/stream', requireAuth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  let set = streams.get(req.user.id);
  if (!set) { set = new Set(); streams.set(req.user.id, set); }
  if (set.size >= 5) { const oldest = set.values().next().value; set.delete(oldest); oldest.end(); }
  set.add(res);
  const beat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(beat);
    set.delete(res);
    if (!set.size) streams.delete(req.user.id);
  });
});

/* ---- Block and report ---- */
app.get('/api/blocks', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT u.username, u.display_name FROM blocks b JOIN users u ON u.id = b.blocked_id
                           WHERE b.blocker_id = ? ORDER BY b.created_at DESC`).all(req.user.id);
  res.json({ blocks: rows.map((r) => ({ username: r.username, displayName: r.display_name })) });
});

app.post('/api/blocks', requireAuth, (req, res) => {
  const name = clean(req.body && req.body.username);
  const target = USERNAME_RE.test(name) ? q.userByName.get(name) : null;
  if (!target) return res.status(404).json({ error: 'No player with that username.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot block yourself.' });
  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(req.user.id, target.id);
  res.json({ ok: true });
});

app.delete('/api/blocks/:username', requireAuth, (req, res) => {
  const target = USERNAME_RE.test(req.params.username) ? q.userByName.get(req.params.username) : null;
  if (target) db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, target.id);
  res.json({ ok: true });
});

const REPORT_REASONS = ['spam', 'harassment', 'scam', 'inappropriate', 'other'];
app.post('/api/reports', requireAuth, reportLimiter, (req, res) => {
  const b = req.body || {};
  const name = clean(b.username);
  const target = USERNAME_RE.test(name) ? q.userByName.get(name) : null;
  if (!target || target.id === req.user.id) return res.status(400).json({ error: 'Choose a valid player to report.' });
  if (!REPORT_REASONS.includes(b.reason)) return res.status(400).json({ error: 'Choose a reason for the report.' });
  const details = clean(b.details);
  if (details.length > 500) return res.status(400).json({ error: 'Details can be up to 500 characters.' });

  // Only the reporter's own conversation with that person can be attached, and only the last 10 messages.
  let convId = null;
  let evidence = [];
  if (b.conversationId) {
    const conv = getConversation(b.conversationId, req.user.id);
    if (conv && otherOf(conv, req.user.id) === target.id) {
      convId = conv.id;
      evidence = q.msgsLast.all(conv.id).slice(0, 10).reverse().map((m) => ({
        from: m.sender_id === req.user.id ? req.user.username : target.username, body: m.body, at: m.created_at
      }));
    }
  }
  db.prepare('INSERT INTO reports (reporter_id, reported_id, conversation_id, reason, details, evidence) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, target.id, convId, b.reason, details, JSON.stringify(evidence));
  res.status(201).json({ ok: true });
});

app.get('/api/admin/reports', requireStaff, (req, res) => {
  const rows = db.prepare(`SELECT r.id, r.reason, r.details, r.evidence, r.status, r.created_at,
                           a.username AS reporter, b.username AS reported
                           FROM reports r JOIN users a ON a.id = r.reporter_id JOIN users b ON b.id = r.reported_id
                           ORDER BY (r.status = 'open') DESC, r.id DESC LIMIT 50`).all();
  res.json({
    reports: rows.map((r) => {
      let evidence = [];
      try { evidence = JSON.parse(r.evidence); } catch { /* keep empty */ }
      return { id: r.id, reason: r.reason, details: r.details, status: r.status, createdAt: r.created_at, reporter: r.reporter, reported: r.reported, evidence };
    })
  });
});

app.patch('/api/admin/reports/:id', requireStaff, (req, res) => {
  const id = Number(req.params.id);
  const rep = Number.isInteger(id) ? db.prepare('SELECT r.id, r.status, r.reason, u.id AS uid, u.username FROM reports r JOIN users u ON u.id = r.reported_id WHERE r.id = ?').get(id) : null;
  if (!rep) return res.status(404).json({ error: 'Report not found.' });
  if (rep.status !== 'resolved') {
    db.transaction(() => {
      db.prepare("UPDATE reports SET status = 'resolved' WHERE id = ?").run(id);
      logMod(req.user, { id: rep.uid, username: rep.username }, 'report.resolve', `Report #${id} (${rep.reason}) marked resolved`);
    })();
  }
  res.json({ ok: true });
});

/* ==========================================================================
   Store, support tickets, moderation and Google sign-in (see lib/)
   ========================================================================== */
const ctx = {
  db, clean, ah, requireAuth, requireStaff, requireAdmin, limiter: mkLimiter, logMod, closeStreams, roleOf,
  userByName: (name) => q.userByName.get(name), startSession, fetchJson, supportEmails: SUPPORT_EMAILS, BASE_URL
};
mountGoogle(app, ctx);
mountStore(app, ctx);
mountSupport(app, ctx);

/* ==========================================================================
   Errors
   ========================================================================== */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

const server = app.listen(PORT, () => {
  console.log(`Bloxfruit Harbour running at ${BASE_URL} (port ${PORT})`);
  if (!ADMINS.size) console.log('Note: ADMIN_USERNAMES is empty, so nobody can edit values yet.');
  if (!ROBLOX.enabled) console.log('Note: Roblox sign-in is off (ROBLOX_CLIENT_ID / ROBLOX_CLIENT_SECRET not set).');
  if (!ctx.googleEnabled) console.log('Note: Google sign-in is off (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set), so the Support account cannot be verified yet.');
  if (payments.fellBack) console.log(`Note: PAYMENT_PROVIDER=${payments.wanted} is not available here, so orders use "${payments.active.name}" payments.`);
  console.log(`Payments: ${payments.active.label}. Support email(s): ${[...SUPPORT_EMAILS].join(', ') || 'none'}.`);
  // Fill the fruit-picture cache in the background. Cached items cost nothing; set IMAGE_WARMUP=0 to skip it.
  if (process.env.IMAGE_WARMUP !== '0') setTimeout(() => images.warm(db.prepare('SELECT * FROM items').all()).catch((e) => console.warn('Image warm-up failed:', e.message)), 3000).unref();
});

setInterval(() => { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); }, 60 * 60 * 1000).unref();

function shutdown() { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
