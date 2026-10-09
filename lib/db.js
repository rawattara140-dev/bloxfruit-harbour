'use strict';
// SQLite database (better-sqlite3): schema, indexes and first-run seed data.
// Every table is created with IF NOT EXISTS, so starting the server is safe at any time.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'harbour.db'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  roblox_id TEXT UNIQUE,
  roblox_username TEXT,
  roblox_display_name TEXT,
  roblox_avatar_url TEXT,
  show_roblox INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  category TEXT NOT NULL DEFAULT 'Fruit',
  type TEXT NOT NULL DEFAULT '',
  rarity TEXT NOT NULL DEFAULT 'Common',
  value REAL NOT NULL DEFAULT 0,          -- trade value in millions ("M")
  demand INTEGER NOT NULL DEFAULT 5,      -- 1 (low) to 10 (very high)
  trend TEXT NOT NULL DEFAULT 'stable',   -- rising | stable | falling
  price_beli INTEGER,                     -- in-game shop price, if any
  notes TEXT NOT NULL DEFAULT '',
  base_fruit TEXT NOT NULL DEFAULT '',    -- for skins: the fruit they belong to
  updated_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);

CREATE TABLE IF NOT EXISTS value_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  old_value REAL,
  new_value REAL NOT NULL,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',    -- open | closed
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status, id);

CREATE TABLE IF NOT EXISTS trade_items (
  trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  side TEXT NOT NULL,                     -- have | want
  qty INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (trade_id, item_id, side)
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS reads (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '[]',    -- last messages, copied at report time by the reporter's choice
  status TEXT NOT NULL DEFAULT 'open',    -- open | resolved
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
`);

// Migration for databases created before skins existed.
if (!db.prepare('PRAGMA table_info(items)').all().some((c) => c.name === 'base_fruit')) {
  db.exec("ALTER TABLE items ADD COLUMN base_fruit TEXT NOT NULL DEFAULT ''");
}

// ---------------------------------------------------------------------------
// Store, support and moderation additions. Every change is additive, so existing databases upgrade in place.
// ---------------------------------------------------------------------------
function addColumn(table, name, ddl) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}
addColumn('users', 'google_sub', 'TEXT');                 // set only after Google confirms a verified email
addColumn('users', 'google_email', 'TEXT');
addColumn('users', 'banned', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'ban_reason', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'banned_at', 'TEXT');
addColumn('items', 'price_npr', 'INTEGER NOT NULL DEFAULT 0');   // whole rupees; 0 = price not set
addColumn('items', 'stock', 'INTEGER NOT NULL DEFAULT 0');       // every item starts out of stock
addColumn('items', 'image_url', "TEXT NOT NULL DEFAULT ''");     // optional admin override for the image source

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users(google_sub) WHERE google_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS google_states (
  state TEXT PRIMARY KEY,
  mode TEXT NOT NULL,                       -- link | login
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  moderator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_warnings_user ON warnings(user_id);

-- Append-only audit trail. Names are copied so the record survives account deletion.
CREATE TABLE IF NOT EXISTS mod_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  moderator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  moderator_name TEXT NOT NULL,
  target_user_id INTEGER,
  target_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TRIGGER IF NOT EXISTS mod_log_no_delete BEFORE DELETE ON mod_log
BEGIN SELECT RAISE(ABORT, 'mod_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS mod_log_no_edit BEFORE UPDATE OF moderator_name, target_user_id, target_name, action, details, created_at ON mod_log
BEGIN SELECT RAISE(ABORT, 'mod_log is append-only'); END;

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- open | in_progress | resolved
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, id);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,                  -- copied at purchase time
  qty INTEGER NOT NULL,
  unit_price_npr INTEGER NOT NULL,          -- copied at purchase time
  total_npr INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | processing | completed | cancelled
  payment_provider TEXT NOT NULL DEFAULT '',
  payment_ref TEXT NOT NULL DEFAULT '',
  roblox_username TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, id);
`);

// ---------------------------------------------------------------------------
// First-run seed (only when the items table is empty). Data lives in lib/seed-values.js.
// Values are in millions. Run `npm run sync-values` to push seed edits into an existing database.
// ---------------------------------------------------------------------------
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  if (count > 0) return;
  const insItem = db.prepare(`INSERT INTO items (name, category, type, rarity, value, demand, trend, price_beli, base_fruit, notes)
    VALUES (@name, @category, @type, @rarity, @value, @demand, @trend, @price_beli, @base_fruit, @notes)`);
  const insHist = db.prepare('INSERT INTO value_history (item_id, item_name, old_value, new_value) VALUES (?, ?, NULL, ?)');
  const { allItems } = require('./seed-values');
  db.transaction(() => {
    for (const item of allItems()) {
      const id = insItem.run(item).lastInsertRowid;
      insHist.run(id, item.name, item.value);
    }
  })();
  console.log('Seeded starting trading values.');
}
seed();

module.exports = db;
