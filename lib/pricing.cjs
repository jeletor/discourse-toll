'use strict';

/**
 * Pricing engine for discourse tolls.
 * 
 * Calculates dynamic pricing based on:
 * - Base cost per action
 * - Progressive cost (more comments in same context = higher price)
 * - Trust discount (higher trust score = lower price)
 * - Cooldown bonus (waiting between actions = cheaper)
 */

const DEFAULT_PRICING = {
  baseSats: 1,              // Base cost per comment/action
  progressiveMultiplier: 1.5, // Each subsequent action in same context costs N× more
  progressiveCap: 50,       // Maximum cost regardless of progression (sats)
  trustDiscount: {
    enabled: true,
    freeAbove: 80,           // Trust score >= this = free (0 sats)
    discountAbove: 30,       // Trust score >= this = discounted
    discountPercent: 50,     // Percent discount for trusted agents
  },
  cooldown: {
    enabled: true,
    windowMs: 60_000,        // Cooldown window (1 minute)
    bonusPercent: 25,        // Discount if last action was > window ago
  },
};

class PricingEngine {
  /**
   * @param {object} opts - Pricing configuration (merged with defaults)
   */
  constructor(opts = {}) {
    this.config = { ...DEFAULT_PRICING, ...opts };
    if (opts.trustDiscount) {
      this.config.trustDiscount = { ...DEFAULT_PRICING.trustDiscount, ...opts.trustDiscount };
    }
    if (opts.cooldown) {
      this.config.cooldown = { ...DEFAULT_PRICING.cooldown, ...opts.cooldown };
    }

    // In-memory activity tracking: contextKey → [{ agent, timestamp }]
    // contextKey is typically thread/post ID
    this._activity = new Map();
    this._agentLastAction = new Map(); // agentId → timestamp
  }

  /**
   * Calculate price for an action.
   * 
   * @param {object} params
   * @param {string} params.agentId - Identifier for the agent (pubkey, username, etc.)
   * @param {string} params.contextId - Context identifier (thread ID, post ID, etc.)
   * @param {number} [params.trustScore] - Agent's trust score (0-100)
   * @param {boolean} [params.dryRun=false] - If true, don't record the action
   * @returns {{ sats: number, breakdown: object }}
   */
  calculate({ agentId, contextId, trustScore, dryRun = false }) {
    const { baseSats, progressiveMultiplier, progressiveCap, trustDiscount, cooldown } = this.config;
    const breakdown = { base: baseSats };

    // --- Progressive pricing ---
    const contextKey = `${contextId}`;
    const contextActivity = this._activity.get(contextKey) || [];
    const agentActionsInContext = contextActivity.filter(a => a.agent === agentId).length;
    
    let progressiveCost = baseSats;
    if (agentActionsInContext > 0) {
      progressiveCost = Math.min(
        Math.ceil(baseSats * Math.pow(progressiveMultiplier, agentActionsInContext)),
        progressiveCap
      );
    }
    breakdown.progressive = progressiveCost;
    breakdown.priorActionsInContext = agentActionsInContext;

    let price = progressiveCost;

    // --- Trust discount ---
    if (trustDiscount.enabled && typeof trustScore === 'number') {
      breakdown.trustScore = trustScore;
      if (trustScore >= trustDiscount.freeAbove) {
        breakdown.trustDiscount = price; // Full discount
        price = 0;
      } else if (trustScore >= trustDiscount.discountAbove) {
        const discount = Math.floor(price * trustDiscount.discountPercent / 100);
        breakdown.trustDiscount = discount;
        price = Math.max(1, price - discount);
      } else {
        breakdown.trustDiscount = 0;
      }
    }

    // --- Cooldown bonus ---
    if (cooldown.enabled && price > 0) {
      const lastAction = this._agentLastAction.get(agentId);
      if (lastAction) {
        const elapsed = Date.now() - lastAction;
        if (elapsed > cooldown.windowMs) {
          const bonus = Math.floor(price * cooldown.bonusPercent / 100);
          breakdown.cooldownBonus = bonus;
          price = Math.max(1, price - bonus);
        } else {
          breakdown.cooldownBonus = 0;
        }
      } else {
        // First action ever — give the bonus
        const bonus = Math.floor(price * cooldown.bonusPercent / 100);
        breakdown.cooldownBonus = bonus;
        price = Math.max(1, price - bonus);
      }
    }

    breakdown.final = price;

    // Record activity (unless dry run)
    if (!dryRun) {
      if (!this._activity.has(contextKey)) {
        this._activity.set(contextKey, []);
      }
      this._activity.get(contextKey).push({ agent: agentId, timestamp: Date.now() });
      this._agentLastAction.set(agentId, Date.now());
    }

    return { sats: price, breakdown };
  }

  /**
   * Get activity count for an agent in a context.
   */
  getActivityCount(agentId, contextId) {
    const activity = this._activity.get(contextId) || [];
    return activity.filter(a => a.agent === agentId).length;
  }

  /**
   * Clear old activity (garbage collection).
   * @param {number} maxAgeMs - Remove entries older than this (default 24h)
   */
  cleanup(maxAgeMs = 86_400_000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, actions] of this._activity.entries()) {
      const filtered = actions.filter(a => a.timestamp > cutoff);
      if (filtered.length === 0) {
        this._activity.delete(key);
      } else {
        this._activity.set(key, filtered);
      }
    }
    for (const [agent, ts] of this._agentLastAction.entries()) {
      if (ts < cutoff) this._agentLastAction.delete(agent);
    }
  }

  /**
   * Get stats about current activity tracking.
   */
  stats() {
    let totalActions = 0;
    for (const actions of this._activity.values()) {
      totalActions += actions.length;
    }
    return {
      contexts: this._activity.size,
      agents: this._agentLastAction.size,
      totalActions,
    };
  }

  /**
   * Reset all activity (for testing).
   */
  reset() {
    this._activity.clear();
    this._agentLastAction.clear();
  }
}

module.exports = { PricingEngine, DEFAULT_PRICING };
