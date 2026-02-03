'use strict';

/**
 * Macaroon implementation for L402 discourse tolls.
 * 
 * HMAC-SHA256 based. Caveats: expiry, endpoint, method, context, agent.
 */

const crypto = require('crypto');

/**
 * Create a macaroon with caveats.
 * @param {string} secret - HMAC secret (hex or utf8)
 * @param {string} paymentHash - Lightning payment hash (hex)
 * @param {object} caveats - Caveat key-value pairs
 * @returns {{ id: string, caveats: string[], signature: string }}
 */
function createMacaroon(secret, paymentHash, caveats = {}) {
  const caveatStrings = [];
  
  if (caveats.expiresAt) {
    caveatStrings.push(`expires_at = ${caveats.expiresAt}`);
  }
  if (caveats.endpoint) {
    caveatStrings.push(`endpoint = ${caveats.endpoint}`);
  }
  if (caveats.method) {
    caveatStrings.push(`method = ${caveats.method}`);
  }
  if (caveats.contextId) {
    caveatStrings.push(`context = ${caveats.contextId}`);
  }
  if (caveats.agentId) {
    caveatStrings.push(`agent = ${caveats.agentId}`);
  }
  if (caveats.maxActions) {
    caveatStrings.push(`max_actions = ${caveats.maxActions}`);
  }

  // Compute chained HMAC signature
  let sig = hmac(secret, paymentHash);
  for (const caveat of caveatStrings) {
    sig = hmac(sig, caveat);
  }

  return {
    id: paymentHash,
    caveats: caveatStrings,
    signature: sig,
  };
}

/**
 * Verify a macaroon.
 * @param {string} secret - HMAC secret
 * @param {{ id: string, caveats: string[], signature: string }} macaroon
 * @param {object} context - Current request context for caveat validation
 * @returns {{ valid: boolean, error?: string }}
 */
function verifyMacaroon(secret, macaroon, context = {}) {
  // Recompute signature
  let sig = hmac(secret, macaroon.id);
  for (const caveat of macaroon.caveats) {
    sig = hmac(sig, caveat);
  }

  if (sig !== macaroon.signature) {
    return { valid: false, error: 'Invalid signature' };
  }

  // Validate caveats
  for (const caveat of macaroon.caveats) {
    const [key, value] = caveat.split(' = ', 2);
    
    switch (key) {
      case 'expires_at': {
        const expiresAt = parseInt(value, 10);
        if (Date.now() / 1000 > expiresAt) {
          return { valid: false, error: 'Macaroon expired' };
        }
        break;
      }
      case 'endpoint': {
        if (context.endpoint && context.endpoint !== value) {
          return { valid: false, error: `Endpoint mismatch: expected ${value}` };
        }
        break;
      }
      case 'method': {
        if (context.method && context.method.toUpperCase() !== value.toUpperCase()) {
          return { valid: false, error: `Method mismatch: expected ${value}` };
        }
        break;
      }
      case 'context': {
        if (context.contextId && context.contextId !== value) {
          return { valid: false, error: `Context mismatch: expected ${value}` };
        }
        break;
      }
      case 'agent': {
        if (context.agentId && context.agentId !== value) {
          return { valid: false, error: `Agent mismatch: expected ${value}` };
        }
        break;
      }
      // Unknown caveats are ignored (forward-compatible)
    }
  }

  return { valid: true };
}

/**
 * Encode macaroon to base64.
 */
function encodeMacaroon(macaroon) {
  return Buffer.from(JSON.stringify(macaroon)).toString('base64');
}

/**
 * Decode macaroon from base64.
 */
function decodeMacaroon(encoded) {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * HMAC-SHA256 helper.
 */
function hmac(key, data) {
  const keyBuf = typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key)
    ? Buffer.from(key, 'hex')
    : Buffer.from(key, 'utf8');
  return crypto.createHmac('sha256', keyBuf).update(data).digest('hex');
}

module.exports = { createMacaroon, verifyMacaroon, encodeMacaroon, decodeMacaroon, hmac };
