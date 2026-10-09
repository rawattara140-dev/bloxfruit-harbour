'use strict';
// Payment layer. The store only talks to this file, so a Nepal provider (eSewa, Khalti, Fonepay, bank QR...)
// can be added later without touching the order code. No secrets live in the frontend: a real provider
// reads its keys from process.env on the server only.
//
// A provider is: { label, enabled, createPayment(order) -> { reference, instructions, redirectUrl?, canSimulate? },
//                  verifyWebhook(req) -> { orderId, paid, reference }   // for real providers, signature-checked }
const PROD = process.env.NODE_ENV === 'production';

const providers = {
  // Safe default for development: no money moves, the buyer can "simulate" payment.
  // Disabled in production unless ALLOW_TEST_PAYMENTS=1, so nobody can get free items on a live site.
  test: {
    label: 'Test payment (no real money)',
    enabled: !PROD || process.env.ALLOW_TEST_PAYMENTS === '1',
    createPayment: (order) => ({
      reference: `TEST-${order.id}`,
      instructions: 'Test mode: no real money is taken. Press "Simulate payment" to mark this order as paid.',
      canSimulate: true
    })
  },
  // Works with no credentials: the order is reserved and staff mark it paid once the money has arrived.
  manual: {
    label: 'Manual payment (staff confirm)',
    enabled: true,
    createPayment: (order) => ({
      reference: `ORD-${order.id}`,
      instructions: process.env.MANUAL_PAYMENT_INSTRUCTIONS ||
        'Your order is reserved. Staff will contact you with payment details, and it is marked paid once payment is confirmed.',
      canSimulate: false
    })
  }
  // esewa: { label, enabled: <true when its key is set in .env>, createPayment(order) { ...redirectUrl... }, verifyWebhook(req) { ... } },
  // khalti: { ... }
};

const wanted = (process.env.PAYMENT_PROVIDER || 'test').toLowerCase();
const name = providers[wanted] && providers[wanted].enabled ? wanted : 'manual';
const active = { name, ...providers[name] };
const fellBack = wanted !== name;

module.exports = { providers, active, wanted, fellBack };
