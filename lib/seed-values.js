'use strict';
// Starting trading values. All values are in MILLIONS (so 5K = 0.005, 3.99B = 3990).
// Edit this file and run `npm run sync-values` to push changes into an existing database,
// or just use the admin Edit buttons on the Values page.

// [name, type, rarity, value (M), demand, Beli shop price or null]
// type/rarity were left blank or guessed for fruits not in the earlier list: check them.
const FRUITS = [
  ['West Dragon', '', 'Mythical', 3990, 10, null],
  ['East Dragon', '', 'Mythical', 3390, 10, null],
  ['Kitsune', 'Beast', 'Mythical', 600, 10, 8000000],
  ['Magnet', '', 'Mythical', 690, 7, null],
  ['Control', 'Natural', 'Mythical', 150, 8, 3200000],
  ['Yeti', '', 'Mythical', 110, 7, null],
  ['Tiger', '', 'Mythical', 120, 8, null],
  ['Dough', 'Natural', 'Mythical', 30, 9, 2800000],
  ['Gas', '', 'Mythical', 60, 8, null],
  ['T-Rex', 'Beast', 'Mythical', 20, 8, 2700000],
  ['Venom', 'Natural', 'Mythical', 20, 7, 3000000],
  ['Lightning', '', 'Mythical', 35, 6, null],
  ['Spirit', 'Natural', 'Mythical', 10, 7, 3400000],
  ['Portal', 'Natural', 'Legendary', 10, 10, 1900000],
  ['Buddha', 'Beast', 'Legendary', 10, 10, 1200000],
  ['Shadow', 'Natural', 'Mythical', 6.5, 5, 2900000],
  ['Mammoth', 'Beast', 'Mythical', 10, 5, 2700000],
  ['Gravity', 'Natural', 'Mythical', 10, 5, 2500000],
  ['Blizzard', 'Elemental', 'Legendary', 5, 5, 2400000],
  ['Phoenix', 'Beast', 'Legendary', 2.75, 3, 1800000],
  ['Sound', 'Natural', 'Legendary', 2.5, 4, 1700000],
  ['Creation', 'Natural', 'Legendary', 2.5, 2, 1400000],
  ['Spider', 'Natural', 'Legendary', 1.5, 2, 1500000],
  ['Rocket', 'Natural', 'Common', 0.005, 1, 5000],
  ['Spin', 'Natural', 'Common', 0.0075, 1, 7500],
  ['Blade', 'Natural', 'Common', 0.05, 1, 30000],
  ['Spring', 'Natural', 'Common', 0.06, 1, 60000],
  ['Smoke', 'Elemental', 'Common', 0.1, 1, 100000],
  ['Spike', 'Natural', 'Common', 0.18, 1, 180000],
  ['Flame', 'Elemental', 'Uncommon', 0.25, 1, 250000],
  ['Eagle', '', 'Uncommon', 0.8, 2, null],
  ['Ice', 'Elemental', 'Uncommon', 0.55, 2, 350000],
  ['Sand', 'Elemental', 'Uncommon', 0.42, 1, 420000],
  ['Dark', 'Elemental', 'Uncommon', 0.4, 1, 500000],
  ['Diamond', 'Natural', 'Uncommon', 1, 2, 600000],
  ['Light', 'Elemental', 'Rare', 0.8, 2, 650000],
  ['Rubber', 'Natural', 'Rare', 0.7, 1, 750000],
  ['Ghost', 'Natural', 'Rare', 0.8, 1, 940000],
  ['Magma', 'Elemental', 'Rare', 1.15, 5, 960000],
  ['Quake', 'Natural', 'Legendary', 1, 2, 1000000],
  ['Love', 'Natural', 'Legendary', 1.5, 3, 1300000]
];

// Skins. [name, base fruit ('' if unknown), value (M), demand, rarity]
// Base fruits were inferred from the skin names; unknown ones are left blank (fix them in the admin editor).
const SKINS = [
  ['Rabid Dog Blade', 'Blade', 22740, 8, 'Special'],
  ['Doghouse (Frame Break)', '', 18900, 10, 'Special'],
  ['Vibe (Frame Break)', '', 16890, 10, 'Special'],
  ['Galaxy Empyrean Kitsune', 'Kitsune', 11370, 10, 'Special'],
  ['Crimson Kitsune', 'Kitsune', 8730, 8, 'Special'],
  ['Parrot', '', 8430, 4, 'Special'],
  ['Ember West Dragon', 'West Dragon', 7530, 9, 'Special'],
  ['Meme-Meme', '', 6810, 8, 'Special'],
  ['Arcsteel Magnet', 'Magnet', 3540, 7, 'Mythical'],
  ['Red Lightning', 'Lightning', 2730, 7, 'Special'],
  ['Divine Portal', 'Portal', 2250, 10, 'Special'],
  ['Runic Fiend', 'Yeti', 2100, 7, 'Mythical'],
  ['Dog Blade', 'Blade', 1740, 10, 'Special'],
  ['Werewolf', '', 1440, 10, 'Special'],
  ['Fiend Yeti', 'Yeti', 1350, 10, 'Mythical'],
  ['Starlight Gravity', 'Gravity', 450, 7, 'Mythical'],
  ['Rose Quartz Diamond', 'Diamond', 300, 7, 'Special'],
  ['Emerald Diamond', 'Diamond', 210, 5, 'Special'],
  ['Yellow Lightning', 'Lightning', 180, 5, 'Special'],
  ['Scarlet Ghost', 'Ghost', 20, 4, 'Special'],
  ['Lime Blade', 'Blade', 10, 2, 'Special']
];

// Shown in the home page spotlight (category "Special"). [name, base fruit, value (M), demand]
const SPECIALS = [
  ['Purple Lightning', 'Lightning', 5520, 7],
  ['Green Lightning', 'Lightning', 330, 7]
];

// Skins that exist but have NO value yet. They are not loaded, so they cannot distort trade totals.
// Add them from the Values page (Add item, category Skin) once you have values.
const PENDING_SKINS = [
  'Topaz Diamond', 'Ruby Diamond', 'Glacier Eagle', 'Requiem Eagle', 'Matrix Eagle',
  'Nuclear Bomb', 'Thermite Bomb', 'Azura Bomb', 'Celebration Bomb'
];

function allItems() {
  const items = [];
  for (const [name, type, rarity, value, demand, price] of FRUITS) {
    items.push({ name, category: 'Fruit', type, rarity, value, demand, trend: 'stable', price_beli: price, base_fruit: '', notes: '' });
  }
  for (const [name, base, value, demand, rarity] of SKINS) {
    items.push({ name, category: 'Skin', type: 'Skin', rarity, value, demand, trend: 'stable', price_beli: null, base_fruit: base, notes: '' });
  }
  for (const [name, base, value, demand] of SPECIALS) {
    items.push({ name, category: 'Special', type: 'Skin', rarity: 'Special', value, demand, trend: 'stable', price_beli: null, base_fruit: base, notes: '' });
  }
  return items;
}

module.exports = { allItems, PENDING_SKINS };
