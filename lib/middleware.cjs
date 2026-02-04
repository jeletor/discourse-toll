'use strict';

/**
 * Express middleware for L402 discourse tolls.
 * 
 * Usage:
 *   const { discourseToll } = require('discourse-toll');
 *   const toll = discourseToll({ secret, nwcUrl });
 *   
 *   app.post('/comments', toll(), (req, res) => { ... });
 *   app.post('/comments', toll({ contextFrom: 'body.threadId' }), (req, res) => { ... });
 */

const { PricingEngine } = require('./pricing.cjs');
const { TrustResolver } = require('./trust.cjs');
const { WalletProvider } = require('./wallet.cjs');
const { createMacaroon, verifyMacaroon, encodeMacaroon, decodeMacaroon } = require('./macaroon.cjs');

/**
 * Create a discourse toll instance.
 * 
 * @param {object} config
 * @param {string} config.secret - HMAC secret for macaroons
 * @param {string} [config.nwcUrl] - NWC connection string for Lightning invoices
 * @param {object} [config.wallet] - Custom wallet: { createInvoice, lookupInvoice }
 * @param {object} [config.pricing] - Pricing config (see PricingEngine)
 * @param {object} [config.trust] - Trust resolver config (see TrustResolver)
 * @param {number} [config.invoiceTtlSecs=600] - Invoice/macaroon TTL (10 min default)
 * @param {string} [config.description] - Default invoice description
 * @returns {Function} Middleware factory
 */
function discourseToll(config) {
  if (!config.secret) throw new Error('discourse-toll: secret is required');
  
  const pricing = new PricingEngine(config.pricing);
  const trust = config.trust instanceof TrustResolver 
    ? config.trust 
    : new TrustResolver(config.trust || {});
  
  const wallet = new WalletProvider(
    config.nwcUrl 
      ? { nwcUrl: config.nwcUrl }
      : config.wallet 
        ? { custom: config.wallet }
        : (() => { throw new Error('discourse-toll: nwcUrl or wallet is required'); })()
  );

  const invoiceTtlSecs = config.invoiceTtlSecs || 600;
  const defaultDescription = config.description || 'Discourse toll';

  /**
   * Returns Express middleware for a specific route.
   * 
   * @param {object} [opts]
   * @param {string} [opts.contextFrom] - Dot-path to extract context ID from req (e.g. 'body.threadId', 'params.postId')
   * @param {string} [opts.agentFrom] - Dot-path to extract agent ID from req (e.g. 'headers.x-agent-id', 'body.author')
   * @param {string} [opts.description] - Invoice description
   * @param {number} [opts.baseSats] - Override base price for this route
   */
  function middleware(opts = {}) {
    return async function discourseTollMiddleware(req, res, next) {
      try {
        // --- Check for existing L402 auth ---
        const authHeader = req.headers.authorization || '';
        if (authHeader.startsWith('L402 ') || authHeader.startsWith('l402 ')) {
          const result = await _verifyL402(authHeader, req, opts);
          if (result.valid) {
            req.tollPaid = true;
            req.tollPaymentHash = result.paymentHash;
            return next();
          }
          return res.status(401).json({
            error: 'Invalid L402 credentials',
            detail: result.error,
          });
        }

        // --- No L402 auth — calculate price and return 402 ---
        const agentId = _extract(req, opts.agentFrom) || req.headers['x-agent-id'] || 'anonymous';
        const contextId = _extract(req, opts.contextFrom) || req.params.threadId || req.params.postId || 'default';

        // Fetch trust score (non-blocking, with timeout)
        let trustScore = null;
        try {
          trustScore = await Promise.race([
            trust.getScore(agentId),
            new Promise(resolve => setTimeout(() => resolve(null), 3000)),
          ]);
        } catch (_) {}

        // Calculate price
        const priceOpts = { agentId, contextId, trustScore, dryRun: true };
        const { sats, breakdown } = pricing.calculate(priceOpts);

        // Free pass
        if (sats === 0) {
          req.tollPaid = true;
          req.tollFree = true;
          req.tollBreakdown = breakdown;
          return next();
        }

        // Create invoice
        const description = opts.description || `${defaultDescription}: ${contextId}`;
        const { invoice, paymentHash } = await wallet.createInvoice(sats, description);

        // Create macaroon
        const expiresAt = Math.floor(Date.now() / 1000) + invoiceTtlSecs;
        const macaroon = createMacaroon(config.secret, paymentHash, {
          expiresAt,
          endpoint: req.originalUrl || req.url,
          method: req.method,
          contextId,
          agentId,
        });
        const encodedMacaroon = encodeMacaroon(macaroon);

        // Return 402
        res.setHeader('WWW-Authenticate', `L402 invoice="${invoice}", macaroon="${encodedMacaroon}"`);
        return res.status(402).json({
          status: 402,
          message: 'Payment Required',
          protocol: 'L402',
          paymentHash,
          invoice,
          macaroon: encodedMacaroon,
          amountSats: sats,
          contextId,
          description,
          pricing: breakdown,
          instructions: {
            step1: 'Pay the Lightning invoice',
            step2: 'Get the preimage from the payment receipt',
            step3: 'Retry with header: Authorization: L402 <macaroon>:<preimage>',
          },
        });
      } catch (err) {
        // On error, let the request through (fail open) but flag it
        console.error('discourse-toll error:', err.message);
        req.tollError = err.message;
        return next();
      }
    };
  }

  /**
   * Verify an L402 authorization header.
   * @private
   */
  async function _verifyL402(authHeader, req, opts) {
    const parts = authHeader.replace(/^l402\s+/i, '').split(':');
    if (parts.length !== 2) {
      return { valid: false, error: 'Invalid L402 format. Expected: L402 <macaroon>:<preimage>' };
    }

    const [encodedMacaroon, preimage] = parts;
    const macaroon = decodeMacaroon(encodedMacaroon);
    if (!macaroon) {
      return { valid: false, error: 'Invalid macaroon encoding' };
    }

    // Verify preimage → payment hash
    if (!wallet.verifyPreimage(preimage, macaroon.id)) {
      return { valid: false, error: 'Preimage does not match payment hash' };
    }

    // Verify macaroon signature and caveats
    const agentId = _extract(req, opts.agentFrom) || req.headers['x-agent-id'] || 'anonymous';
    const contextId = _extract(req, opts.contextFrom) || req.params.threadId || req.params.postId || 'default';

    const verification = verifyMacaroon(config.secret, macaroon, {
      endpoint: req.originalUrl || req.url,
      method: req.method,
      contextId,
      agentId,
    });

    if (!verification.valid) {
      return verification;
    }

    // Record the action in pricing engine (for progressive pricing)
    pricing.calculate({ agentId, contextId, dryRun: false });

    return { valid: true, paymentHash: macaroon.id };
  }

  /**
   * Extract a value from req using a dot-path.
   * @private
   */
  function _extract(req, path) {
    if (!path) return null;
    return path.split('.').reduce((obj, key) => obj && obj[key], req);
  }

  // Expose internals for advanced use
  middleware.pricing = pricing;
  middleware.trust = trust;
  middleware.wallet = wallet;
  middleware.stats = () => ({
    pricing: pricing.stats(),
    trust: trust.stats(),
    wallet: wallet.stats(),
  });
  middleware.cleanup = () => pricing.cleanup();
  middleware.close = () => wallet.close();

  return middleware;
}

module.exports = { discourseToll };
