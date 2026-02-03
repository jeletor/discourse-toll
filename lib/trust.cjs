'use strict';

/**
 * Trust resolver — fetches trust scores for agents.
 * 
 * Default implementation queries ai.wot (Nostr NIP-32 attestations).
 * Pluggable: provide your own resolver function.
 */

const { Relay, useWebSocketImplementation } = require('nostr-tools/relay');

// Try to use ws in Node.js
try {
  const WebSocket = require('ws');
  useWebSocketImplementation(WebSocket);
} catch (_) {
  // Browser environment — native WebSocket
}

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

const ATTESTATION_WEIGHTS = {
  'service-quality': 1.5,
  'identity-continuity': 1.0,
  'general-trust': 0.8,
  'work-completed': 1.2,
};

class TrustResolver {
  /**
   * @param {object} opts
   * @param {string[]} [opts.relays] - Nostr relays to query
   * @param {number} [opts.timeoutMs=5000] - Query timeout
   * @param {number} [opts.cacheTtlMs=300000] - Cache TTL (5 min default)
   * @param {Function} [opts.resolver] - Custom resolver: (agentId) => Promise<number>
   */
  constructor(opts = {}) {
    this.relays = opts.relays || DEFAULT_RELAYS;
    this.timeoutMs = opts.timeoutMs || 5000;
    this.cacheTtlMs = opts.cacheTtlMs || 300_000;
    this.customResolver = opts.resolver || null;
    this._cache = new Map(); // pubkey → { score, fetchedAt }
  }

  /**
   * Get trust score for an agent.
   * @param {string} agentId - Nostr pubkey (hex) or other identifier
   * @returns {Promise<number|null>} Trust score 0-100, or null if unknown
   */
  async getScore(agentId) {
    if (this.customResolver) {
      return this.customResolver(agentId);
    }

    // Check cache
    const cached = this._cache.get(agentId);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.score;
    }

    // Query ai.wot attestations from Nostr
    try {
      const score = await this._queryNostr(agentId);
      this._cache.set(agentId, { score, fetchedAt: Date.now() });
      return score;
    } catch (err) {
      // On error, return cached value if any (even if stale), else null
      return cached ? cached.score : null;
    }
  }

  /**
   * Query Nostr relays for ai.wot attestations about a pubkey.
   * @private
   */
  async _queryNostr(pubkey) {
    const attestations = [];

    for (const relayUrl of this.relays) {
      try {
        const relay = await Relay.connect(relayUrl);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            relay.close();
            resolve();
          }, this.timeoutMs);

          relay.subscribe(
            [{
              kinds: [1985],
              '#L': ['ai.wot'],
              '#p': [pubkey],
              limit: 50,
            }],
            {
              onevent: (event) => {
                if (event.pubkey !== pubkey) { // Don't count self-attestations
                  attestations.push(event);
                }
              },
              oneose: () => {
                clearTimeout(timer);
                relay.close();
                resolve();
              },
            }
          );
        });
        break; // Got results from one relay, that's enough
      } catch (_) {
        continue; // Try next relay
      }
    }

    if (attestations.length === 0) return null;
    return this._calculateScore(attestations);
  }

  /**
   * Calculate trust score from attestations.
   * Simplified version of ai.wot scoring.
   * @private
   */
  _calculateScore(attestations) {
    let weightedSum = 0;
    let totalWeight = 0;
    const seenAttesters = new Set();

    for (const event of attestations) {
      // Skip duplicate attesters (use latest)
      if (seenAttesters.has(event.pubkey)) continue;
      seenAttesters.add(event.pubkey);

      // Find attestation type from tags
      const lTag = event.tags.find(t => t[0] === 'l' && t[2] === 'ai.wot');
      const type = lTag ? lTag[1] : 'general-trust';
      const weight = ATTESTATION_WEIGHTS[type] || 0.8;

      // Temporal decay (90-day half-life)
      const ageMs = Date.now() - event.created_at * 1000;
      const halfLifeMs = 90 * 86_400_000;
      const decay = Math.pow(0.5, ageMs / halfLifeMs);

      weightedSum += weight * decay;
      totalWeight += weight;
    }

    if (totalWeight === 0) return 0;

    // Normalize to 0-100 scale
    // 5+ unique attesters with good types → approaches 100
    const uniqueAttesters = seenAttesters.size;
    const networkFactor = Math.min(1, uniqueAttesters / 5);
    const qualityFactor = weightedSum / totalWeight;
    
    return Math.round(networkFactor * qualityFactor * 100);
  }

  /**
   * Clear cache.
   */
  clearCache() {
    this._cache.clear();
  }

  /**
   * Get cache stats.
   */
  stats() {
    return {
      cacheSize: this._cache.size,
      relays: this.relays.length,
    };
  }
}

/**
 * Create a simple static trust resolver from a map of scores.
 * Useful for testing or when you have scores from another source.
 */
function staticResolver(scores) {
  return new TrustResolver({
    resolver: async (agentId) => scores[agentId] ?? null,
  });
}

/**
 * Create a resolver that queries the ai.wot REST API.
 * @param {string} apiUrl - Base URL (e.g. https://wot.jeletor.cc)
 */
function apiResolver(apiUrl) {
  return new TrustResolver({
    resolver: async (agentId) => {
      try {
        const https = require('https');
        const http = require('http');
        const mod = apiUrl.startsWith('https') ? https : http;
        
        return new Promise((resolve) => {
          const req = mod.get(`${apiUrl}/v1/score/${agentId}`, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
              try {
                const data = JSON.parse(body);
                resolve(typeof data.score === 'number' ? data.score : null);
              } catch {
                resolve(null);
              }
            });
          });
          req.on('error', () => resolve(null));
          req.setTimeout(5000, () => { req.destroy(); resolve(null); });
        });
      } catch {
        return null;
      }
    },
  });
}

module.exports = { TrustResolver, staticResolver, apiResolver, DEFAULT_RELAYS, ATTESTATION_WEIGHTS };
