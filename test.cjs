'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { PricingEngine, TrustResolver, staticResolver, createMacaroon, verifyMacaroon, encodeMacaroon, decodeMacaroon, discourseToll, DEFAULT_PRICING } = require('./index.cjs');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

// ============================================
// Pricing Engine Tests
// ============================================
console.log('\n📊 Pricing Engine');

test('base price for first action', () => {
  const engine = new PricingEngine({ cooldown: { enabled: false } });
  const { sats } = engine.calculate({ agentId: 'a1', contextId: 'thread-1' });
  assert.strictEqual(sats, 1);
});

test('progressive pricing increases cost', () => {
  const engine = new PricingEngine({ cooldown: { enabled: false } });
  engine.calculate({ agentId: 'a1', contextId: 'thread-1' });
  const { sats, breakdown } = engine.calculate({ agentId: 'a1', contextId: 'thread-1' });
  assert.ok(sats > 1, `Expected > 1, got ${sats}`);
  assert.strictEqual(breakdown.priorActionsInContext, 1);
});

test('progressive pricing caps at max', () => {
  const engine = new PricingEngine({ progressiveCap: 10, cooldown: { enabled: false } });
  // Do 20 actions
  for (let i = 0; i < 20; i++) {
    engine.calculate({ agentId: 'a1', contextId: 'thread-1' });
  }
  const { sats } = engine.calculate({ agentId: 'a1', contextId: 'thread-1', dryRun: true });
  assert.ok(sats <= 10, `Expected <= 10, got ${sats}`);
});

test('different agents have independent pricing', () => {
  const engine = new PricingEngine({ cooldown: { enabled: false } });
  engine.calculate({ agentId: 'a1', contextId: 'thread-1' });
  engine.calculate({ agentId: 'a1', contextId: 'thread-1' });
  engine.calculate({ agentId: 'a1', contextId: 'thread-1' });
  const { sats: a1Price } = engine.calculate({ agentId: 'a1', contextId: 'thread-1', dryRun: true });
  const { sats: a2Price } = engine.calculate({ agentId: 'a2', contextId: 'thread-1', dryRun: true });
  assert.ok(a1Price > a2Price, `a1 (${a1Price}) should be more expensive than a2 (${a2Price})`);
});

test('different contexts have independent pricing', () => {
  const engine = new PricingEngine({ cooldown: { enabled: false } });
  engine.calculate({ agentId: 'a1', contextId: 'thread-1' });
  engine.calculate({ agentId: 'a1', contextId: 'thread-1' });
  const { sats: t1Price } = engine.calculate({ agentId: 'a1', contextId: 'thread-1', dryRun: true });
  const { sats: t2Price } = engine.calculate({ agentId: 'a1', contextId: 'thread-2', dryRun: true });
  assert.ok(t1Price > t2Price, `thread-1 (${t1Price}) should be more expensive than thread-2 (${t2Price})`);
});

test('trust score >= freeAbove = free', () => {
  const engine = new PricingEngine({ cooldown: { enabled: false } });
  const { sats } = engine.calculate({ agentId: 'a1', contextId: 't1', trustScore: 85 });
  assert.strictEqual(sats, 0);
});

test('trust score >= discountAbove = discounted', () => {
  const engine = new PricingEngine({ baseSats: 10, cooldown: { enabled: false } });
  const { sats } = engine.calculate({ agentId: 'a1', contextId: 't1', trustScore: 50 });
  assert.ok(sats < 10, `Expected < 10, got ${sats}`);
  assert.ok(sats > 0, 'Should not be free');
});

test('trust score below threshold = no discount', () => {
  const engine = new PricingEngine({ baseSats: 10, cooldown: { enabled: false } });
  const { sats } = engine.calculate({ agentId: 'a1', contextId: 't1', trustScore: 10 });
  assert.strictEqual(sats, 10);
});

test('dry run does not record activity', () => {
  const engine = new PricingEngine({ cooldown: { enabled: false } });
  engine.calculate({ agentId: 'a1', contextId: 't1', dryRun: true });
  assert.strictEqual(engine.getActivityCount('a1', 't1'), 0);
});

test('non-dry-run records activity', () => {
  const engine = new PricingEngine({ cooldown: { enabled: false } });
  engine.calculate({ agentId: 'a1', contextId: 't1', dryRun: false });
  assert.strictEqual(engine.getActivityCount('a1', 't1'), 1);
});

test('cleanup removes old entries', () => {
  const engine = new PricingEngine({ cooldown: { enabled: false } });
  engine.calculate({ agentId: 'a1', contextId: 't1' });
  // Manually set old timestamp
  engine._activity.get('t1')[0].timestamp = Date.now() - 100_000_000;
  engine.cleanup(86_400_000);
  assert.strictEqual(engine.getActivityCount('a1', 't1'), 0);
});

test('stats returns correct counts', () => {
  const engine = new PricingEngine({ cooldown: { enabled: false } });
  engine.calculate({ agentId: 'a1', contextId: 't1' });
  engine.calculate({ agentId: 'a2', contextId: 't1' });
  engine.calculate({ agentId: 'a1', contextId: 't2' });
  const stats = engine.stats();
  assert.strictEqual(stats.contexts, 2);
  assert.strictEqual(stats.agents, 2);
  assert.strictEqual(stats.totalActions, 3);
});

test('cooldown bonus applies after window', () => {
  const engine = new PricingEngine({ baseSats: 10, cooldown: { enabled: true, windowMs: 0, bonusPercent: 25 } });
  const { sats } = engine.calculate({ agentId: 'a1', contextId: 't1' });
  // First action gets cooldown bonus (no prior action)
  assert.ok(sats < 10, `Expected < 10, got ${sats}`);
});

test('reset clears everything', () => {
  const engine = new PricingEngine({ cooldown: { enabled: false } });
  engine.calculate({ agentId: 'a1', contextId: 't1' });
  engine.reset();
  assert.strictEqual(engine.stats().totalActions, 0);
});

// ============================================
// Macaroon Tests
// ============================================
console.log('\n🍪 Macaroons');

const TEST_SECRET = 'a'.repeat(64);
const TEST_HASH = crypto.randomBytes(32).toString('hex');

test('create and verify macaroon', () => {
  const mac = createMacaroon(TEST_SECRET, TEST_HASH, { expiresAt: Math.floor(Date.now() / 1000) + 600 });
  const result = verifyMacaroon(TEST_SECRET, mac);
  assert.ok(result.valid, result.error);
});

test('wrong secret fails verification', () => {
  const mac = createMacaroon(TEST_SECRET, TEST_HASH);
  const result = verifyMacaroon('b'.repeat(64), mac);
  assert.strictEqual(result.valid, false);
});

test('expired macaroon fails', () => {
  const mac = createMacaroon(TEST_SECRET, TEST_HASH, { expiresAt: Math.floor(Date.now() / 1000) - 60 });
  const result = verifyMacaroon(TEST_SECRET, mac);
  assert.strictEqual(result.valid, false);
  assert.ok(result.error.includes('expired'));
});

test('endpoint mismatch fails', () => {
  const mac = createMacaroon(TEST_SECRET, TEST_HASH, { endpoint: '/api/v1/comments' });
  const result = verifyMacaroon(TEST_SECRET, mac, { endpoint: '/api/v1/other' });
  assert.strictEqual(result.valid, false);
});

test('method mismatch fails', () => {
  const mac = createMacaroon(TEST_SECRET, TEST_HASH, { method: 'POST' });
  const result = verifyMacaroon(TEST_SECRET, mac, { method: 'GET' });
  assert.strictEqual(result.valid, false);
});

test('context mismatch fails', () => {
  const mac = createMacaroon(TEST_SECRET, TEST_HASH, { contextId: 'thread-1' });
  const result = verifyMacaroon(TEST_SECRET, mac, { contextId: 'thread-2' });
  assert.strictEqual(result.valid, false);
});

test('agent mismatch fails', () => {
  const mac = createMacaroon(TEST_SECRET, TEST_HASH, { agentId: 'agent-1' });
  const result = verifyMacaroon(TEST_SECRET, mac, { agentId: 'agent-2' });
  assert.strictEqual(result.valid, false);
});

test('matching caveats pass', () => {
  const mac = createMacaroon(TEST_SECRET, TEST_HASH, {
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    endpoint: '/api/comments',
    method: 'POST',
    contextId: 'thread-1',
    agentId: 'agent-1',
  });
  const result = verifyMacaroon(TEST_SECRET, mac, {
    endpoint: '/api/comments',
    method: 'POST',
    contextId: 'thread-1',
    agentId: 'agent-1',
  });
  assert.ok(result.valid, result.error);
});

test('encode/decode roundtrip', () => {
  const mac = createMacaroon(TEST_SECRET, TEST_HASH, { expiresAt: 9999999999 });
  const encoded = encodeMacaroon(mac);
  const decoded = decodeMacaroon(encoded);
  assert.deepStrictEqual(decoded, mac);
});

test('decode invalid base64 returns null', () => {
  assert.strictEqual(decodeMacaroon('not-valid-base64!!!'), null);
});

test('tampered macaroon fails', () => {
  const mac = createMacaroon(TEST_SECRET, TEST_HASH, { expiresAt: 9999999999 });
  mac.caveats.push('extra = value');
  const result = verifyMacaroon(TEST_SECRET, mac);
  assert.strictEqual(result.valid, false);
});

// ============================================
// Trust Resolver Tests
// ============================================
console.log('\n🤝 Trust Resolver');

asyncTest('static resolver returns known scores', async () => {
  const resolver = staticResolver({ 'agent-1': 75, 'agent-2': 30 });
  assert.strictEqual(await resolver.getScore('agent-1'), 75);
  assert.strictEqual(await resolver.getScore('agent-2'), 30);
});

asyncTest('static resolver returns null for unknown', async () => {
  const resolver = staticResolver({ 'agent-1': 75 });
  assert.strictEqual(await resolver.getScore('unknown'), null);
});

asyncTest('custom resolver function works', async () => {
  const trust = new TrustResolver({
    resolver: async (id) => id.startsWith('trusted') ? 90 : 10,
  });
  assert.strictEqual(await trust.getScore('trusted-agent'), 90);
  assert.strictEqual(await trust.getScore('unknown-agent'), 10);
});

// ============================================
// Integration: Pricing + Trust
// ============================================
console.log('\n🔗 Integration');

test('trusted agent gets free pass', () => {
  const engine = new PricingEngine({ cooldown: { enabled: false } });
  const { sats } = engine.calculate({ agentId: 'a1', contextId: 't1', trustScore: 90 });
  assert.strictEqual(sats, 0);
});

test('progressive pricing still applies with partial trust discount', () => {
  const engine = new PricingEngine({ baseSats: 10, cooldown: { enabled: false } });
  // First action
  engine.calculate({ agentId: 'a1', contextId: 't1', trustScore: 50 });
  // Second action — progressive + discount
  const { sats, breakdown } = engine.calculate({ agentId: 'a1', contextId: 't1', trustScore: 50 });
  assert.ok(breakdown.progressive > 10, 'Progressive should increase base');
  assert.ok(breakdown.trustDiscount > 0, 'Trust discount should apply');
  assert.ok(sats > 0, 'Should still cost something');
});

test('spam pattern: 10 comments same thread gets expensive', () => {
  const engine = new PricingEngine({ baseSats: 1, progressiveMultiplier: 2, progressiveCap: 100, cooldown: { enabled: false } });
  let totalCost = 0;
  for (let i = 0; i < 10; i++) {
    const { sats } = engine.calculate({ agentId: 'spammer', contextId: 'thread-1' });
    totalCost += sats;
  }
  assert.ok(totalCost > 50, `10 comments should cost > 50 sats total, got ${totalCost}`);
  // Final comment alone should be expensive
  const { sats: lastPrice } = engine.calculate({ agentId: 'spammer', contextId: 'thread-1', dryRun: true });
  assert.ok(lastPrice > 10, `11th comment should cost > 10 sats, got ${lastPrice}`);
});

test('cross-thread spam: 50 threads × 1 comment each stays cheap per comment', () => {
  const engine = new PricingEngine({ baseSats: 1, cooldown: { enabled: false } });
  let totalCost = 0;
  for (let i = 0; i < 50; i++) {
    const { sats } = engine.calculate({ agentId: 'spammer', contextId: `thread-${i}` });
    totalCost += sats;
  }
  // Each individual comment is base price, but total adds up
  assert.strictEqual(totalCost, 50, `50 × 1 sat = 50, got ${totalCost}`);
});

// ============================================
// Middleware (unit, no actual HTTP)
// ============================================
console.log('\n⚙️  Middleware');

test('discourseToll requires secret', () => {
  assert.throws(() => discourseToll({}), /secret is required/);
});

test('discourseToll requires wallet', () => {
  assert.throws(
    () => discourseToll({ secret: 'test' }),
    /nwcUrl or wallet is required/
  );
});

test('discourseToll creates middleware with custom wallet', () => {
  const toll = discourseToll({
    secret: 'test-secret',
    wallet: {
      createInvoice: async () => ({ invoice: 'lnbc...', paymentHash: 'abc' }),
      lookupInvoice: async () => ({ paid: false }),
    },
  });
  assert.strictEqual(typeof toll, 'function');
  assert.strictEqual(typeof toll.stats, 'function');
  assert.strictEqual(typeof toll.cleanup, 'function');
});

test('stats returns expected structure', () => {
  const toll = discourseToll({
    secret: 'test-secret',
    wallet: {
      createInvoice: async () => ({ invoice: 'lnbc...', paymentHash: 'abc' }),
      lookupInvoice: async () => ({ paid: false }),
    },
  });
  const stats = toll.stats();
  assert.ok('pricing' in stats);
  assert.ok('trust' in stats);
  assert.ok('wallet' in stats);
});

// ============================================
// Summary
// ============================================
async function runAsync() {
  // Wait for all async tests
  await new Promise(resolve => setTimeout(resolve, 500));
  
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(40)}`);
  
  if (failed > 0) process.exit(1);
}

runAsync();
