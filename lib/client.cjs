'use strict';

/**
 * Client SDK for paying discourse tolls.
 * 
 * Usage:
 *   const { createDiscourseClient } = require('discourse-toll');
 *   const client = createDiscourseClient({ nwcUrl, maxSats: 50 });
 *   
 *   const result = await client.post('https://forum.example/api/comments', {
 *     body: JSON.stringify({ text: 'Great post!', threadId: '123' }),
 *     headers: { 'Content-Type': 'application/json' },
 *   });
 */

const https = require('https');
const http = require('http');

let NWCClient;
try {
  NWCClient = require('@getalby/sdk').NWCClient;
} catch (_) {}

/**
 * Create a discourse client that auto-pays L402 tolls.
 * 
 * @param {object} opts
 * @param {string} opts.nwcUrl - NWC connection string for paying invoices
 * @param {number} [opts.maxSats=100] - Maximum sats to pay per request
 * @param {number} [opts.maxSatsPerContext=500] - Max sats per context/thread
 * @param {string} [opts.agentId] - Agent identifier to send in headers
 * @param {number} [opts.timeoutMs=15000] - Request timeout
 * @returns {object} Client with fetch, post, get methods
 */
function createDiscourseClient(opts = {}) {
  if (!opts.nwcUrl) throw new Error('discourse-toll client: nwcUrl required');
  if (!NWCClient) throw new Error('discourse-toll client: @getalby/sdk required');

  const wallet = new NWCClient({ nostrWalletConnectUrl: opts.nwcUrl });
  const maxSats = opts.maxSats || 100;
  const maxSatsPerContext = opts.maxSatsPerContext || 500;
  const agentId = opts.agentId || null;
  const timeoutMs = opts.timeoutMs || 15000;

  // Track spend per context
  const _contextSpend = new Map();

  /**
   * Make an HTTP request, auto-paying L402 if needed.
   * 
   * @param {string} url - Request URL
   * @param {object} [fetchOpts] - fetch-like options (method, headers, body)
   * @returns {Promise<{ status: number, headers: object, body: string, json: Function, paid: boolean, sats: number }>}
   */
  async function request(url, fetchOpts = {}) {
    const headers = { ...fetchOpts.headers };
    if (agentId) headers['X-Agent-Id'] = agentId;

    // First request
    const res1 = await _httpRequest(url, { ...fetchOpts, headers });

    // Not a 402 — return directly
    if (res1.status !== 402) {
      return { ...res1, paid: false, sats: 0 };
    }

    // Parse 402 response
    let tollData;
    try {
      tollData = JSON.parse(res1.body);
      if (tollData.detail) tollData = tollData.detail; // Colony wraps in detail
    } catch {
      throw new Error('Invalid 402 response — not JSON');
    }

    const { invoice, macaroon, amountSats, contextId: tollContextId } = tollData;
    if (!invoice || !macaroon) {
      throw new Error('402 response missing invoice or macaroon');
    }

    // Check budget
    if (amountSats > maxSats) {
      throw new Error(`Toll too expensive: ${amountSats} sats (max: ${maxSats})`);
    }

    // Check per-context budget
    const contextId = tollContextId || 'unknown';
    const spent = _contextSpend.get(contextId) || 0;
    if (spent + amountSats > maxSatsPerContext) {
      throw new Error(`Context budget exceeded: ${spent + amountSats} sats in context ${contextId} (max: ${maxSatsPerContext})`);
    }

    // Pay the invoice
    const payment = await wallet.payInvoice({ invoice });
    if (!payment.preimage) {
      throw new Error('Payment succeeded but no preimage returned');
    }

    // Track spend
    _contextSpend.set(contextId, spent + amountSats);

    // Retry with L402 auth
    const l402Headers = {
      ...headers,
      Authorization: `L402 ${macaroon}:${payment.preimage}`,
    };

    const res2 = await _httpRequest(url, { ...fetchOpts, headers: l402Headers });
    return { ...res2, paid: true, sats: amountSats };
  }

  /**
   * POST convenience method.
   */
  async function post(url, body, headers = {}) {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    return request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: bodyStr,
    });
  }

  /**
   * GET convenience method.
   */
  async function get(url, headers = {}) {
    return request(url, { method: 'GET', headers });
  }

  /**
   * Get spend stats.
   */
  function stats() {
    let totalSpent = 0;
    const contexts = {};
    for (const [ctx, sats] of _contextSpend.entries()) {
      contexts[ctx] = sats;
      totalSpent += sats;
    }
    return { totalSpent, contexts, maxSats, maxSatsPerContext };
  }

  /**
   * Close wallet connection.
   */
  function close() {
    wallet.close();
  }

  /**
   * Raw HTTP request helper.
   * @private
   */
  function _httpRequest(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const reqOpts = {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: (opts.method || 'GET').toUpperCase(),
        headers: opts.headers || {},
      };

      const req = mod.request(reqOpts, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          json: () => JSON.parse(body),
        }));
      });

      req.on('error', reject);
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Request timeout')); });
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  return { request, post, get, stats, close };
}

module.exports = { createDiscourseClient };
