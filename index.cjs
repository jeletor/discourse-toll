'use strict';

/**
 * discourse-toll — L402 micropayment middleware for discourse
 * 
 * Trust-weighted, progressive pricing for forums and APIs.
 * Combines Lightning payments, ai.wot trust scores, and 
 * discourse-specific pricing into one Express middleware.
 * 
 * @example
 * // Server
 * const { discourseToll } = require('discourse-toll');
 * const toll = discourseToll({ secret: process.env.TOLL_SECRET, nwcUrl: process.env.NWC_URL });
 * app.post('/api/comments', toll({ contextFrom: 'body.threadId' }), handler);
 * 
 * @example
 * // Client
 * const { createDiscourseClient } = require('discourse-toll');
 * const client = createDiscourseClient({ nwcUrl, maxSats: 50, agentId: myPubkey });
 * const res = await client.post('https://forum.example/api/comments', { text: 'Hello', threadId: '123' });
 */

const { discourseToll } = require('./lib/middleware.cjs');
const { createDiscourseClient } = require('./lib/client.cjs');
const { PricingEngine, DEFAULT_PRICING } = require('./lib/pricing.cjs');
const { TrustResolver, staticResolver, apiResolver } = require('./lib/trust.cjs');
const { WalletProvider } = require('./lib/wallet.cjs');
const { createMacaroon, verifyMacaroon, encodeMacaroon, decodeMacaroon } = require('./lib/macaroon.cjs');

module.exports = {
  // Main API
  discourseToll,
  createDiscourseClient,
  
  // Building blocks (for custom setups)
  PricingEngine,
  TrustResolver,
  WalletProvider,
  
  // Trust resolver factories
  staticResolver,
  apiResolver,
  
  // Macaroon utilities
  createMacaroon,
  verifyMacaroon,
  encodeMacaroon,
  decodeMacaroon,
  
  // Constants
  DEFAULT_PRICING,
};
