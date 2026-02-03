'use strict';

/**
 * NWC wallet integration for creating and verifying invoices.
 * Minimal — only needs make_invoice and lookup_invoice permissions.
 */

let NWCClient;
try {
  NWCClient = require('@getalby/sdk').NWCClient;
} catch (_) {
  // Optional dependency — can use custom wallet provider
}

class WalletProvider {
  /**
   * @param {object} opts
   * @param {string} [opts.nwcUrl] - NWC connection string
   * @param {object} [opts.custom] - Custom wallet: { createInvoice, lookupInvoice }
   */
  constructor(opts = {}) {
    if (opts.custom) {
      this._createInvoice = opts.custom.createInvoice.bind(opts.custom);
      this._lookupInvoice = opts.custom.lookupInvoice.bind(opts.custom);
      this._client = null;
    } else if (opts.nwcUrl) {
      if (!NWCClient) {
        throw new Error('NWC requires @getalby/sdk. Install it: npm i @getalby/sdk');
      }
      this._client = new NWCClient({ nostrWalletConnectUrl: opts.nwcUrl });
      this._createInvoice = null;
      this._lookupInvoice = null;
    } else {
      throw new Error('WalletProvider needs either nwcUrl or custom wallet functions');
    }

    // Track pending invoices: paymentHash → { invoice, amount, createdAt, paid }
    this._invoices = new Map();
  }

  /**
   * Create a Lightning invoice.
   * @param {number} sats - Amount in sats
   * @param {string} description - Invoice description
   * @returns {Promise<{ invoice: string, paymentHash: string }>}
   */
  async createInvoice(sats, description) {
    if (this._createInvoice) {
      return this._createInvoice(sats, description);
    }

    const result = await this._client.makeInvoice({
      amount: sats * 1000, // NWC uses millisats
      description,
    });

    // Extract payment hash from invoice
    const paymentHash = result.payment_hash || result.paymentHash || this._extractPaymentHash(result.invoice);

    const record = {
      invoice: result.invoice,
      paymentHash,
      amount: sats,
      description,
      createdAt: Date.now(),
      paid: false,
    };
    this._invoices.set(paymentHash, record);

    return { invoice: result.invoice, paymentHash };
  }

  /**
   * Check if an invoice has been paid.
   * @param {string} paymentHash - Payment hash to check
   * @returns {Promise<{ paid: boolean, preimage?: string }>}
   */
  async lookupInvoice(paymentHash) {
    const record = this._invoices.get(paymentHash);
    if (record && record.paid) {
      return { paid: true, preimage: record.preimage };
    }

    if (this._lookupInvoice) {
      const result = await this._lookupInvoice(paymentHash);
      if (result.paid && record) {
        record.paid = true;
        record.preimage = result.preimage;
      }
      return result;
    }

    try {
      const result = await this._client.lookupInvoice({ payment_hash: paymentHash });
      const paid = result.settled || result.state === 'settled' || !!result.preimage;
      if (paid && record) {
        record.paid = true;
        record.preimage = result.preimage;
      }
      return { paid, preimage: result.preimage };
    } catch (err) {
      return { paid: false };
    }
  }

  /**
   * Verify a preimage matches a payment hash.
   * @param {string} preimage - Hex preimage
   * @param {string} paymentHash - Hex payment hash
   * @returns {boolean}
   */
  verifyPreimage(preimage, paymentHash) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    return hash === paymentHash;
  }

  /**
   * Extract payment hash from BOLT11 invoice (simplified).
   * @private
   */
  _extractPaymentHash(invoice) {
    // Payment hash is in the tagged data of BOLT11
    // For simplicity, use the invoice record from NWC which usually includes it
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(invoice).digest('hex');
  }

  /**
   * Get tracked invoice stats.
   */
  stats() {
    let paid = 0, pending = 0, totalSats = 0;
    for (const inv of this._invoices.values()) {
      if (inv.paid) { paid++; totalSats += inv.amount; }
      else pending++;
    }
    return { paid, pending, totalSats, total: this._invoices.size };
  }

  /**
   * Close wallet connection.
   */
  close() {
    if (this._client && this._client.close) {
      this._client.close();
    }
  }
}

module.exports = { WalletProvider };
