'use strict';
// Pushes lib/seed-values.js into an existing database: updates items that exist, adds new ones.
// Changed values are written to the history so they appear under "Recent updates".
// Items that are not in the seed file are left untouched. Run: npm run sync-values
require('dotenv').config();
const db = require('../lib/db');
const { allItems, PENDING_SKINS } = require('../lib/seed-values');

const find = db.prepare('SELECT * FROM items WHERE name = ?');
const ins = db.prepare(`INSERT INTO items (name, category, type, rarity, value, demand, trend, price_beli, base_fruit, notes)
  VALUES (@name, @category, @type, @rarity, @value, @demand, @trend, @price_beli, @base_fruit, @notes)`);
const upd = db.prepare(`UPDATE items SET category=@category, type=@type, rarity=@rarity, value=@value, demand=@demand,
  price_beli=@price_beli, base_fruit=@base_fruit, notes=@notes, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=@id`);
const hist = db.prepare('INSERT INTO value_history (item_id, item_name, old_value, new_value) VALUES (?, ?, ?, ?)');

let added = 0, changed = 0, same = 0;
db.transaction(() => {
  // Earlier versions called this item just "Green".
  const oldGreen = find.get('Green');
  if (oldGreen && !find.get('Green Lightning')) db.prepare("UPDATE items SET name = 'Green Lightning' WHERE id = ?").run(oldGreen.id);

  for (const item of allItems()) {
    const row = find.get(item.name);
    if (!row) { hist.run(ins.run(item).lastInsertRowid, item.name, null, item.value); added++; continue; }
    if (row.value === item.value && row.demand === item.demand && row.rarity === item.rarity && row.base_fruit === item.base_fruit
        && row.category === item.category && row.type === item.type && row.notes === item.notes && row.price_beli === item.price_beli) { same++; continue; }
    const { name, trend, ...fields } = item; // keep the existing trend; name is the lookup key
    upd.run({ ...fields, id: row.id });
    if (row.value !== item.value) hist.run(row.id, item.name, row.value, item.value);
    changed++;
  }
})();
console.log(`Added ${added}, updated ${changed}, unchanged ${same}.`);
console.log(`${PENDING_SKINS.length} skins still have no value and were not loaded.`);
