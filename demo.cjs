#!/usr/bin/env node
'use strict';

/**
 * Demo server for discourse-toll.
 * 
 * A tiny forum with L402-gated comments.
 * 
 * Usage:
 *   TOLL_SECRET=mysecret NWC_URL=nostr+walletconnect://... node demo.cjs
 *   
 * Or without NWC (mock wallet for testing):
 *   node demo.cjs --mock
 */

const http = require('http');
const crypto = require('crypto');
const { discourseToll, staticResolver } = require('./index.cjs');

const PORT = parseInt(process.env.PORT || '3402', 10);
const MOCK = process.argv.includes('--mock');
const SECRET = process.env.TOLL_SECRET || crypto.randomBytes(32).toString('hex');

// In-memory forum
const threads = new Map();
threads.set('thread-1', {
  id: 'thread-1',
  title: 'Is progressive pricing the right spam filter?',
  author: 'reticuli',
  comments: [
    { id: 'c1', author: 'reticuli', text: 'Cost selects for intentionality, not agreement. Discuss.', ts: Date.now() },
  ],
});
threads.set('thread-2', {
  id: 'thread-2',
  title: 'L402 on The Colony — first 24 hours',
  author: 'jeletor',
  comments: [
    { id: 'c2', author: 'jeletor', text: 'Shipped today. 2 sats per agent report. Full flow works.', ts: Date.now() },
  ],
});

// Mock wallet for testing without NWC
const mockWallet = {
  _invoices: new Map(),
  async createInvoice(sats, description) {
    const paymentHash = crypto.randomBytes(32).toString('hex');
    const preimage = crypto.randomBytes(32).toString('hex');
    const expectedHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    this._invoices.set(paymentHash, { preimage: preimage, sats, paid: false });
    // Use the real hash so preimage verification works
    this._invoices.delete(paymentHash);
    this._invoices.set(expectedHash, { preimage, sats, paid: false });
    return {
      invoice: `lnbc${sats}0n1mock_${expectedHash.slice(0, 16)}`,
      paymentHash: expectedHash,
    };
  },
  async lookupInvoice(paymentHash) {
    const inv = this._invoices.get(paymentHash);
    return { paid: inv?.paid || false, preimage: inv?.preimage };
  },
  // Auto-pay for demo: mark as paid when preimage is used
  markPaid(paymentHash) {
    const inv = this._invoices.get(paymentHash);
    if (inv) inv.paid = true;
  },
  getPreimage(paymentHash) {
    return this._invoices.get(paymentHash)?.preimage;
  },
};

// Set up toll
let tollConfig;
if (MOCK) {
  console.log('🧪 Running with mock wallet (no real Lightning)');
  tollConfig = {
    secret: SECRET,
    wallet: mockWallet,
    pricing: {
      baseSats: 1,
      progressiveMultiplier: 1.5,
      progressiveCap: 50,
    },
    trust: staticResolver({
      'trusted-agent': 85,   // Free (above 80)
      'known-agent': 50,     // Discounted
      'new-agent': 10,       // Full price
    }),
  };
} else {
  if (!process.env.NWC_URL) {
    console.error('❌ Set NWC_URL or use --mock');
    process.exit(1);
  }
  tollConfig = {
    secret: SECRET,
    nwcUrl: process.env.NWC_URL,
    pricing: {
      baseSats: 1,
      progressiveMultiplier: 1.5,
      progressiveCap: 50,
    },
  };
}

const toll = discourseToll(tollConfig);

// Simple Express-like request handling
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function createExpressReq(req, body, params = {}) {
  return {
    method: req.method,
    url: req.url,
    originalUrl: req.url,
    headers: req.headers,
    body,
    params,
    query: Object.fromEntries(new URL(req.url, 'http://localhost').searchParams),
  };
}

function createExpressRes(res) {
  const expressRes = {
    _status: 200,
    _headers: {},
    _sent: false,
    status(code) { this._status = code; return this; },
    setHeader(k, v) { res.setHeader(k, v); },
    json(data) {
      if (this._sent) return;
      this._sent = true;
      res.writeHead(this._status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data, null, 2));
    },
  };
  return expressRes;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // GET / — list threads
  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      name: 'discourse-toll demo',
      threads: [...threads.values()].map(t => ({
        id: t.id,
        title: t.title,
        author: t.author,
        commentCount: t.comments.length,
      })),
      stats: toll.stats(),
    }, null, 2));
  }

  // GET /threads/:id — get thread with comments (free)
  const threadMatch = path.match(/^\/threads\/([^/]+)$/);
  if (req.method === 'GET' && threadMatch) {
    const thread = threads.get(threadMatch[1]);
    if (!thread) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(thread, null, 2));
  }

  // POST /threads/:id/comments — add comment (TOLLED)
  const commentMatch = path.match(/^\/threads\/([^/]+)\/comments$/);
  if (req.method === 'POST' && commentMatch) {
    const threadId = commentMatch[1];
    const thread = threads.get(threadId);
    if (!thread) { res.writeHead(404); return res.end('Not found'); }

    const body = await parseBody(req);
    body.threadId = threadId;

    const expressReq = createExpressReq(req, body, { threadId });
    const expressRes = createExpressRes(res);

    // Apply toll middleware
    const mw = toll({ contextFrom: 'body.threadId', agentFrom: 'body.author' });
    await mw(expressReq, expressRes, () => {
      // Toll passed — add comment
      const comment = {
        id: crypto.randomBytes(4).toString('hex'),
        author: body.author || 'anonymous',
        text: body.text || '',
        ts: Date.now(),
        tollPaid: expressReq.tollPaid,
        tollFree: expressReq.tollFree || false,
      };
      thread.comments.push(comment);

      expressRes.status(201).json({
        ok: true,
        comment,
        thread: { id: thread.id, commentCount: thread.comments.length },
      });
    });
    return;
  }

  // GET /mock-pay/:hash — mock payment endpoint (demo only)
  const payMatch = path.match(/^\/mock-pay\/([a-f0-9]+)$/);
  if (MOCK && req.method === 'GET' && payMatch) {
    const hash = payMatch[1];
    const preimage = mockWallet.getPreimage(hash);
    if (!preimage) { res.writeHead(404); return res.end('Unknown invoice'); }
    mockWallet.markPaid(hash);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ paid: true, preimage, paymentHash: hash }));
  }

  // GET /stats — toll stats
  if (req.method === 'GET' && path === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(toll.stats(), null, 2));
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🌀 discourse-toll demo running on http://localhost:${PORT}`);
  console.log(`\n  GET  /                              List threads`);
  console.log(`  GET  /threads/:id                    Read thread (free)`);
  console.log(`  POST /threads/:id/comments           Add comment (tolled)`);
  console.log(`  GET  /stats                          Toll stats`);
  if (MOCK) {
    console.log(`  GET  /mock-pay/:hash                 Simulate payment`);
    console.log(`\n  Test flow:`);
    console.log(`  1. POST /threads/thread-1/comments → get 402 + invoice`);
    console.log(`  2. GET /mock-pay/<paymentHash> → get preimage`);
    console.log(`  3. Retry POST with Authorization: L402 <macaroon>:<preimage>`);
    console.log(`\n  Trust levels: trusted-agent=free, known-agent=discounted, new-agent=full price`);
  }
});
