/**
 * discourse-toll — L402 micropayment middleware for discourse
 * Trust-weighted, progressive pricing for forums and APIs.
 */

import { Request, Response, NextFunction } from 'express';

// ─── Pricing ───────────────────────────────────────────

export interface PricingConfig {
  baseSats?: number;
  progressiveMultiplier?: number;
  progressiveCap?: number;
  trustDiscount?: {
    enabled?: boolean;
    freeAbove?: number;
    discountAbove?: number;
    discountPercent?: number;
  };
  cooldown?: {
    enabled?: boolean;
    windowMs?: number;
    bonusPercent?: number;
  };
}

export interface PriceBreakdown {
  base: number;
  progressive: number;
  priorActionsInContext: number;
  trustScore?: number;
  trustDiscount?: number;
  cooldownBonus?: number;
  final: number;
}

export interface PriceResult {
  sats: number;
  breakdown: PriceBreakdown;
}

export class PricingEngine {
  constructor(opts?: PricingConfig);
  calculate(params: {
    agentId: string;
    contextId: string;
    trustScore?: number;
    dryRun?: boolean;
  }): PriceResult;
  getActivityCount(agentId: string, contextId: string): number;
  cleanup(maxAgeMs?: number): void;
  stats(): { contexts: number; agents: number; totalActions: number };
  reset(): void;
}

export const DEFAULT_PRICING: PricingConfig;

// ─── Trust ─────────────────────────────────────────────

export class TrustResolver {
  constructor(opts?: {
    relays?: string[];
    timeoutMs?: number;
    cacheTtlMs?: number;
    resolver?: (agentId: string) => Promise<number | null>;
  });
  getScore(agentId: string): Promise<number | null>;
  clearCache(): void;
  stats(): { cacheSize: number; relays: number };
}

export function staticResolver(scores: Record<string, number>): TrustResolver;
export function apiResolver(apiUrl: string): TrustResolver;

// ─── Wallet ────────────────────────────────────────────

export class WalletProvider {
  constructor(opts: {
    nwcUrl?: string;
    custom?: {
      createInvoice: (sats: number, description: string) => Promise<{ invoice: string; paymentHash: string }>;
      lookupInvoice: (paymentHash: string) => Promise<{ paid: boolean; preimage?: string }>;
    };
  });
  createInvoice(sats: number, description: string): Promise<{ invoice: string; paymentHash: string }>;
  lookupInvoice(paymentHash: string): Promise<{ paid: boolean; preimage?: string }>;
  verifyPreimage(preimage: string, paymentHash: string): boolean;
  stats(): { paid: number; pending: number; totalSats: number; total: number };
  close(): void;
}

// ─── Macaroon ──────────────────────────────────────────

export interface Macaroon {
  id: string;
  caveats: string[];
  signature: string;
}

export function createMacaroon(secret: string, paymentHash: string, caveats?: {
  expiresAt?: number;
  endpoint?: string;
  method?: string;
  contextId?: string;
  agentId?: string;
  maxActions?: number;
}): Macaroon;

export function verifyMacaroon(secret: string, macaroon: Macaroon, context?: {
  endpoint?: string;
  method?: string;
  contextId?: string;
  agentId?: string;
}): { valid: boolean; error?: string };

export function encodeMacaroon(macaroon: Macaroon): string;
export function decodeMacaroon(encoded: string): Macaroon | null;

// ─── Middleware ─────────────────────────────────────────

export interface TollConfig {
  secret: string;
  nwcUrl?: string;
  wallet?: {
    createInvoice: (sats: number, description: string) => Promise<{ invoice: string; paymentHash: string }>;
    lookupInvoice: (paymentHash: string) => Promise<{ paid: boolean; preimage?: string }>;
  };
  pricing?: PricingConfig;
  trust?: TrustResolver;
  invoiceTtlSecs?: number;
  description?: string;
}

export interface RouteOpts {
  contextFrom?: string;
  agentFrom?: string;
  description?: string;
  baseSats?: number;
}

export interface TollMiddleware {
  (opts?: RouteOpts): (req: Request, res: Response, next: NextFunction) => Promise<void>;
  pricing: PricingEngine;
  trust: TrustResolver;
  wallet: WalletProvider;
  stats(): {
    pricing: { contexts: number; agents: number; totalActions: number };
    trust: { cacheSize: number; relays: number };
    wallet: { paid: number; pending: number; totalSats: number; total: number };
  };
  cleanup(): void;
  close(): void;
}

export function discourseToll(config: TollConfig): TollMiddleware;

// ─── Client ────────────────────────────────────────────

export interface ClientResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  json(): any;
  paid: boolean;
  sats: number;
}

export interface DiscourseClient {
  request(url: string, opts?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<ClientResponse>;
  post(url: string, body: any, headers?: Record<string, string>): Promise<ClientResponse>;
  get(url: string, headers?: Record<string, string>): Promise<ClientResponse>;
  stats(): {
    totalSpent: number;
    contexts: Record<string, number>;
    maxSats: number;
    maxSatsPerContext: number;
  };
  close(): void;
}

export function createDiscourseClient(opts: {
  nwcUrl: string;
  maxSats?: number;
  maxSatsPerContext?: number;
  agentId?: string;
  timeoutMs?: number;
}): DiscourseClient;
