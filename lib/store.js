'use strict';
// Fruit store: public stock list, buying, the buyer's orders, and the staff inventory/order tools.
// Money is whole Nepalese rupees (NPR, shown as "Rs."). Stock is reserved when an order is placed and
// handed back if the order is cancelled.
const payments = require('./payments');

const ORDER_STATUSES = ['pending', 'paid', 'processing', 'completed', 'cancelled'];
// What staff may change an order to. completed and cancelled are final.
const NEXT = { pending: ['paid', 'cancelled'], paid: ['processing', 'completed', 'cancelled'], processing: ['completed', 'cancelled'], completed: [], cancelled: [] };
const MAX_PENDING_PER_USER = 3;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

const int = (v, min, max) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const npr = (n) => `Rs. ${Number(n).toLocaleString('en-IN')}`;

module.exports = function mountStore(app, ctx) {
  const { db, clean, requireAuth, requireStaff, limiter, logMod } = ctx;
  const orderLimiter = limiter(60 * 60 * 1000, 10, 'You are placing orders too fast. Try again later.');

  const itemOut = (r) => ({
    id: r.id, name: r.name, category: r.category, rarity: r.rarity, baseFruit: r.base_fruit,
    priceNpr: r.price_npr, stock: r.stock, available: r.stock > 0 && r.price_npr > 0
  });
  const orderOut = (r) => ({
    id: r.id, itemId: r.item_id, itemName: r.item_name, qty: r.qty, unitPriceNpr: r.unit_price_npr, totalNpr: r.total_npr,
    status: r.status, paymentRef: r.payment_ref, robloxUsername: r.roblox_username, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at
  });
  const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

  const getItem = db.prepare('SELECT * FROM items WHERE id = ?');
  const getOrder = db.prepare('SELECT * FROM orders WHERE id = ?');
  // Gives the reserved stock back. Only ever called as part of a status change away from an active state.
  const restock = db.prepare('UPDATE items SET stock = stock + ? WHERE id = ?');
  const setStatus = db.prepare(`UPDATE orders SET status = ?, updated_at = ${NOW} WHERE id = ?`);

  /* ---------------- public store ---------------- */
  app.get('/api/store', (req, res) => {
    const where = [];
    const params = {};
    const text = clean(String(req.query.q || '')).slice(0, 40);
    if (text) { where.push("name LIKE @q ESCAPE '\\'"); params.q = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`; }
    if (req.query.category) { where.push('category = @category'); params.category = clean(String(req.query.category)).slice(0, 30); }
    const rows = db.prepare(`SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                             ORDER BY (stock > 0 AND price_npr > 0) DESC, name ASC LIMIT 500`).all(params);
    const categories = db.prepare('SELECT DISTINCT category FROM items ORDER BY category').all().map((r) => r.category);
    res.json({ currency: 'NPR', items: rows.map(itemOut), categories, payment: { provider: payments.active.name, label: payments.active.label } });
  });

  /* ---------------- buying ---------------- */
  app.post('/api/store/orders', requireAuth, orderLimiter, (req, res) => {
    const b = req.body || {};
    const itemId = int(b.itemId, 1, Number.MAX_SAFE_INTEGER);
    const qty = int(b.qty, 1, 99);
    const robloxUsername = clean(b.robloxUsername);
    const note = clean(b.note);
    if (!itemId) return res.status(400).json({ error: 'Choose a fruit to buy.' });
    if (!qty) return res.status(400).json({ error: 'Quantity must be a whole number from 1 to 99.' });
    if (!USERNAME_RE.test(robloxUsername)) return res.status(400).json({ error: 'Enter your Roblox username (3 to 20 letters, numbers or underscores) so we know where to deliver.' });
    if (note.length > 200) return res.status(400).json({ error: 'Notes can be up to 200 characters.' });

    const result = db.transaction(() => {
      const item = getItem.get(itemId);
      if (!item) return { code: 404, error: 'That fruit does not exist.' };
      if (item.stock <= 0) return { code: 409, error: `${item.name} is out of stock.` };
      if (item.price_npr <= 0) return { code: 409, error: `${item.name} is not for sale right now.` };
      if (qty > item.stock) return { code: 409, error: `Only ${item.stock} of ${item.name} left in stock.` };
      const pending = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status = 'pending'").get(req.user.id).n;
      if (pending >= MAX_PENDING_PER_USER) return { code: 429, error: `You already have ${MAX_PENDING_PER_USER} unpaid orders. Pay for or cancel one first.` };
      // The guard in the WHERE clause is what makes overselling impossible, even if two requests race.
      const took = db.prepare('UPDATE items SET stock = stock - ? WHERE id = ? AND stock >= ? AND price_npr > 0').run(qty, item.id, qty);
      if (took.changes !== 1) return { code: 409, error: `${item.name} just sold out.` };
      const id = db.prepare(`INSERT INTO orders (user_id, item_id, item_name, qty, unit_price_npr, total_npr, payment_provider, roblox_username, note)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, item.id, item.name, qty, item.price_npr, item.price_npr * qty, payments.active.name, robloxUsername, note).lastInsertRowid;
      const pay = payments.active.createPayment({ id });
      db.prepare('UPDATE orders SET payment_ref = ? WHERE id = ?').run(pay.reference, id);
      return { order: getOrder.get(id), pay };
    })();
    if (result.error) return res.status(result.code).json({ error: result.error });
    res.status(201).json({
      order: orderOut(result.order),
      payment: { provider: payments.active.name, label: payments.active.label, instructions: result.pay.instructions, canSimulate: Boolean(result.pay.canSimulate), redirectUrl: result.pay.redirectUrl || null }
    });
  });

  app.get('/api/store/orders', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
    res.json({ orders: rows.map(orderOut), canSimulate: Boolean(payments.active.createPayment({ id: 0 }).canSimulate) });
  });

  function ownOrder(req, res) {
    const id = int(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    const o = id ? getOrder.get(id) : null;
    if (!o || o.user_id !== req.user.id) { res.status(404).json({ error: 'Order not found.' }); return null; }
    return o;
  }

  // The buyer can cancel an order that has not been paid; the reserved stock goes back on the shelf.
  app.post('/api/store/orders/:id/cancel', requireAuth, (req, res) => {
    const o = ownOrder(req, res);
    if (!o) return;
    if (o.status !== 'pending') return res.status(409).json({ error: 'Only unpaid orders can be cancelled here. Contact support for anything else.' });
    db.transaction(() => { setStatus.run('cancelled', o.id); if (o.item_id) restock.run(o.qty, o.item_id); })();
    res.json({ ok: true });
  });

  // Test provider only: pretends the money arrived. Refused whenever the test provider is not active.
  app.post('/api/store/orders/:id/pay-test', requireAuth, (req, res) => {
    if (!(payments.active.name === 'test' && payments.active.enabled)) return res.status(403).json({ error: 'Test payments are not enabled on this server.' });
    const o = ownOrder(req, res);
    if (!o) return;
    if (o.status !== 'pending') return res.status(409).json({ error: 'This order is not waiting for payment.' });
    setStatus.run('paid', o.id);
    res.json({ ok: true });
  });

  // Reserved for a future provider's server-to-server callback (not under /api, so the browser-only CSRF header
  // does not apply; the provider's own signature check, inside verifyWebhook, is what protects it).
  app.post('/webhooks/payments/:provider', (req, res) => {
    const p = payments.providers[String(req.params.provider)];
    if (!p || typeof p.verifyWebhook !== 'function' || !p.enabled) return res.status(501).json({ error: 'No payment provider is configured for this callback.' });
    res.status(501).json({ error: 'Not implemented.' });
  });

  /* ---------------- staff: inventory ---------------- */
  app.get('/api/staff/inventory', requireStaff, (req, res) => {
    const where = [];
    const params = {};
    if (req.query.out === '1') where.push('stock = 0');
    const text = clean(String(req.query.q || '')).slice(0, 40);
    if (text) { where.push("name LIKE @q ESCAPE '\\'"); params.q = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`; }
    const rows = db.prepare(`SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name ASC LIMIT 500`).all(params);
    const all = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(stock = 0), 0) AS out FROM items').get();
    res.json({ items: rows.map(itemOut), total: all.total, outOfStock: all.out });
  });

  // Body: { stock } sets an exact amount, { delta } adds or removes, { priceNpr } changes the price. Any mix is fine.
  app.patch('/api/staff/inventory/:id', requireStaff, (req, res) => {
    const id = int(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    const item = id ? getItem.get(id) : null;
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    const b = req.body || {};
    let stock = item.stock;
    let price = item.price_npr;
    if (b.stock !== undefined) {
      stock = int(b.stock, 0, 100000);
      if (stock === null) return res.status(400).json({ error: 'Stock must be a whole number from 0 to 100,000.' });
    } else if (b.delta !== undefined) {
      const d = int(b.delta, -100000, 100000);
      if (d === null) return res.status(400).json({ error: 'The change must be a whole number.' });
      stock = item.stock + d;
      if (stock < 0) return res.status(400).json({ error: `Only ${item.stock} in stock, so it cannot go down by ${-d}.` });
      if (stock > 100000) return res.status(400).json({ error: 'Stock cannot go above 100,000.' });
    }
    if (b.priceNpr !== undefined) {
      price = int(b.priceNpr, 0, 10000000);
      if (price === null) return res.status(400).json({ error: 'Price must be a whole number of rupees from 0 to 10,000,000.' });
    }
    if (stock > 0 && price <= 0) return res.status(400).json({ error: 'Set a price before putting this item in stock.' });
    if (stock === item.stock && price === item.price_npr) return res.json({ ok: true, item: itemOut(item) });
    const parts = [];
    if (stock !== item.stock) parts.push(`stock ${item.stock} -> ${stock}`);
    if (price !== item.price_npr) parts.push(`price ${npr(item.price_npr)} -> ${npr(price)}`);
    db.transaction(() => {
      db.prepare('UPDATE items SET stock = ?, price_npr = ? WHERE id = ?').run(stock, price, item.id);
      logMod(req.user, null, 'inventory.update', `${item.name}: ${parts.join(', ')}`);
    })();
    res.json({ ok: true, item: itemOut(getItem.get(item.id)) });
  });

  /* ---------------- staff: orders ---------------- */
  app.get('/api/staff/orders', requireStaff, (req, res) => {
    const status = ORDER_STATUSES.includes(req.query.status) ? req.query.status : null;
    const rows = db.prepare(`SELECT o.*, u.username FROM orders o JOIN users u ON u.id = o.user_id
                             ${status ? 'WHERE o.status = ?' : ''} ORDER BY o.id DESC LIMIT 100`).all(...(status ? [status] : []));
    res.json({ orders: rows.map((r) => ({ ...orderOut(r), username: r.username, nextStatuses: NEXT[r.status] || [] })), statuses: ORDER_STATUSES });
  });

  app.patch('/api/staff/orders/:id', requireStaff, (req, res) => {
    const id = int(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    const o = id ? getOrder.get(id) : null;
    if (!o) return res.status(404).json({ error: 'Order not found.' });
    const status = req.body && req.body.status;
    if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown order status.' });
    if (!(NEXT[o.status] || []).includes(status)) return res.status(409).json({ error: `An order that is ${o.status} cannot be changed to ${status}.` });
    const buyer = db.prepare('SELECT id, username FROM users WHERE id = ?').get(o.user_id);
    db.transaction(() => {
      setStatus.run(status, o.id);
      if (status === 'cancelled' && o.item_id) restock.run(o.qty, o.item_id);
      logMod(req.user, buyer, 'order.status', `Order #${o.id} (${o.qty} x ${o.item_name}, ${npr(o.total_npr)}): ${o.status} -> ${status}${status === 'cancelled' ? ', stock returned' : ''}`);
    })();
    res.json({ ok: true });
  });
};
module.exports.ORDER_STATUSES = ORDER_STATUSES;
