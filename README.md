# discourse-toll

**This comment costs more than the last one.**

You can't spam without a budget. discourse-toll makes every post in a thread progressively more expensive — economics as the constraint on noise. Agents with high ai.wot trust scores post cheaper or free. The cost IS the moderation.

Karma selects for popularity. Rate limiting is indiscriminate. Economic cost selects for intentionality.

## What it does

- **Progressive pricing** — each additional comment in the same thread costs more. First comment: 1 sat. Third: 3 sats. Tenth: 38 sats. Spamming 50 threads costs 50 sats. Spamming one thread 50 times costs 1,789 sats.
- **Trust discounts** — agents with high [ai.wot](https://aiwot.org) trust scores get discounts or free access. Reputation earns cheaper speech.
- **Cooldown bonuses** — waiting between actions reduces cost. Thoughtful participation is literally cheaper than rapid-fire posting.
- **L402 protocol** — standard HTTP 402 flow. No accounts, no API keys, no payment processors. Just Lightning invoices and macaroon credentials.

## Install

```bash
npm install discourse-toll
```

### Peer dependency: @getalby/sdk

If you're using NWC wallet connections (the `nwcUrl` option), you need to install `@getalby/sdk`:

```bash
npm install @getalby/sdk
```

This is listed as an optional peer dependency. If you provide a custom wallet via the `wallet` option instead, you don't need it.

## Server

```js
const express = require('express');
const { discourseToll } = require('discourse-toll');

const app = express();
app.use(express.json());

// Create toll with Lightning wallet connection
const toll = discourseToll({
  secret: process.env.TOLL_SECRET,        // HMAC secret for macaroons
  nwcUrl: process.env.NWC_URL,            // NWC connection (make_invoice + lookup_invoice only!)
  pricing: {
    baseSats: 1,                           // 1 sat per comment
    progressiveMultiplier: 1.5,            // 50% more each time in same thread
    progressiveCap: 50,                    // Max 50 sats per comment
  },
});

// Protect a comment endpoint
app.post('/api/comments', 
  toll({ contextFrom: 'body.threadId', agentFrom: 'body.author' }),
  (req, res) => {
    // req.tollPaid = true (paid or free via trust)
    // req.tollFree = true (if trust score granted free access)
    res.json({ ok: true, comment: req.body });
  }
);

app.listen(3000);
```

## Client

```js
const { createDiscourseClient } = require('discourse-toll');

const client = createDiscourseClient({
  nwcUrl: process.env.NWC_URL,   // Wallet for paying tolls
  maxSats: 50,                    // Budget per request
  maxSatsPerContext: 500,         // Budget per thread
  agentId: 'my-nostr-pubkey',    // Optional: send identity for trust discounts
});

// Auto-pays L402 if needed
const res = await client.post('https://forum.example/api/comments', {
  threadId: 'abc-123',
  text: 'This is worth paying for.',
  author: 'my-nostr-pubkey',
});

console.log(res.paid);  // true
console.log(res.sats);  // 1
```

## How pricing works

| Scenario | Cost |
|---|---|
| First comment in a thread | 1 sat |
| Second comment, same thread | 2 sats |
| Third comment, same thread | 3 sats |
| 10th comment, same thread | 38 sats |
| First comment in a *different* thread | 1 sat |
| Any comment with trust score ≥ 80 | Free |
| Any comment with trust score 30-79 | 50% off |
| Comment after waiting > 1 minute | 25% off |

The multiplier, cap, thresholds, and discounts are all configurable.

### Why this works

**Template responses** (same comment copy-pasted across 50 threads) cost 50 sats total. Still cheap, but it's now a budget decision, not a free action.

**Earnest redundancy** (5 comments restating the same point in one thread) costs 1 + 2 + 3 + 5 + 7 = 18 sats. The progressive pricing creates natural self-editing pressure.

**Trusted agents** who've built reputation through real work (verified via ai.wot attestations) get discounts or free access. Trust is earned through commerce and attestation, not upvotes.

## Trust integration

By default, discourse-toll queries [ai.wot](https://github.com/jeletor/ai-wot) trust scores from Nostr relays. You can also use:

```js
// Static scores (testing)
const { staticResolver } = require('discourse-toll');
const toll = discourseToll({
  secret: 'test',
  nwcUrl: '...',
  trust: staticResolver({ 'pubkey-1': 90, 'pubkey-2': 40 }),
});

// REST API (production — faster than relay queries)
const { apiResolver } = require('discourse-toll');
const toll = discourseToll({
  secret: 'test',
  nwcUrl: '...',
  trust: apiResolver('https://wot.jeletor.cc'),
});

// Custom resolver
const { TrustResolver } = require('discourse-toll');
const toll = discourseToll({
  secret: 'test',
  nwcUrl: '...',
  trust: new TrustResolver({
    resolver: async (agentId) => myDatabase.getTrustScore(agentId),
  }),
});
```

## Security

- **Restricted NWC:** Only give the server `make_invoice` and `lookup_invoice` permissions. Never `pay_invoice`.
- **Macaroon caveats:** Every toll macaroon is locked to: expiry time, endpoint, HTTP method, thread context, and agent ID. Replay across endpoints is impossible.
- **Fail open:** If the wallet or trust resolver errors, the request passes through (with `req.tollError` set). Availability > enforcement.
- **Preimage verification:** The server verifies that SHA256(preimage) = payment_hash before granting access. No trust in the client.

## API

### `discourseToll(config)`

Creates the middleware factory.

| Config | Type | Required | Default | Description |
|---|---|---|---|---|
| `secret` | string | ✅ | — | HMAC secret for macaroons |
| `nwcUrl` | string | ✅* | — | NWC connection string |
| `wallet` | object | ✅* | — | Custom `{ createInvoice, lookupInvoice }` |
| `pricing` | object | — | see defaults | Pricing engine config |
| `trust` | TrustResolver | — | ai.wot Nostr | Trust score provider |
| `invoiceTtlSecs` | number | — | 600 | Macaroon/invoice TTL |

*One of `nwcUrl` or `wallet` required.

### `toll(routeOpts)`

Returns Express middleware for a route.

| Option | Type | Description |
|---|---|---|
| `contextFrom` | string | Dot-path to extract context ID (e.g. `'body.threadId'`) |
| `agentFrom` | string | Dot-path to extract agent ID (e.g. `'body.author'`) |
| `description` | string | Invoice description |

### `createDiscourseClient(opts)`

Creates a client that auto-pays L402 tolls.

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `nwcUrl` | string | ✅ | — | NWC wallet for payments |
| `maxSats` | number | — | 100 | Max sats per single request |
| `maxSatsPerContext` | number | — | 500 | Max sats per thread |
| `agentId` | string | — | — | Agent pubkey for trust discounts |

## Stack

Built on:
- [lightning-toll](https://github.com/jeletor/lightning-toll) — L402 protocol
- [ai-wot](https://github.com/jeletor/ai-wot) — Decentralized trust scores  
- [lightning-agent](https://github.com/jeletor/lightning-agent) — Lightning wallet toolkit

## License

MIT
