require('dotenv').config();
const axios = require('axios');

// Base URL and API key can be overridden by the admin panel at runtime
// (stored in localdb's paymentSettings) — these .env values are just the
// initial defaults. Callers should pass { baseUrl, apiKey } when they have
// fresher values from fb.getPaymentSettings().
const DEFAULT_BASE_URL = process.env.FAMPAY_BASE_URL || 'https://pay.zapupi.com';
const DEFAULT_API_KEY = process.env.FAMPAY_API_KEY;

function client(overrides = {}) {
  return axios.create({
    baseURL: overrides.baseUrl || DEFAULT_BASE_URL,
    headers: { 'Content-Type': 'application/json' }
  });
}

function resolveZapKey(settings = {}) {
  return settings.apiKey || DEFAULT_API_KEY;
}

/**
 * Creates a ZapUPI order. Returns a payment_url the customer opens to pay —
 * ZapUPI hosts its own QR/payment page, so there's no separate QR-image step.
 * Docs: POST /api/create-order
 * Body: { zap_key, order_id, amount, customer_mobile?, remark?, cashier_id?,
 *         success_url?, failed_url?, timeout_url?, webhook_url? }
 * 200 response: { status: "success", order_id, txn_id, payment_url, ... }
 */
async function generateQr(upiId, amount, settings = {}) {
  try {
    // orderId must be unique per attempt — ZapUPI ties txn_id to this.
    const orderId = settings.orderId || `ord_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

    const body = {
      zap_key: resolveZapKey(settings),
      order_id: orderId,
      amount
    };
    if (settings.customerMobile) body.customer_mobile = settings.customerMobile;
    if (settings.remark) body.remark = settings.remark;
    if (settings.webhookUrl) body.webhook_url = settings.webhookUrl;

    const response = await client(settings).post('/api/create-order', body);

    if (response.data.status !== 'success') {
      return { success: false, error: response.data.message || 'Order creation failed' };
    }

    return {
      success: true,
      orderId, // our own order_id — used later to poll /api/order-status
      famTxnId: response.data.txn_id,
      paymentUrl: response.data.payment_url,
      // No separate QR image from ZapUPI — deliverProduct/showOrderSummary code
      // that expects qr.qrImageUrl should instead link/redirect to paymentUrl.
      qrImageUrl: null,
      amount
    };
  } catch (err) {
    console.error('ZapUPI create-order failed:', err.response?.data || err.message);
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

/**
 * Polls ZapUPI for the live status of a previously created order.
 * Docs: POST /api/order-status
 * Body: { zap_key, order_id }
 * 200 response: { status: "success", data: { order_id, status: "Pending"|"Success"|"Failed", ... } }
 */
async function checkVerificationStatus(orderId, settings = {}) {
  try {
    const body = {
      zap_key: resolveZapKey(settings),
      order_id: orderId
    };

    const response = await client(settings).post('/api/order-status', body);
    const data = response.data?.data;
    if (!data) return null;

    // Normalize to lowercase so bot.js's status === 'success' / 'failed' checks work
    const statusMap = { pending: 'pending', success: 'success', failed: 'failed' };
    const normalizedStatus = statusMap[String(data.status).toLowerCase()] || String(data.status).toLowerCase();

    return {
      status: normalizedStatus,
      verified: normalizedStatus === 'success',
      amount: data.amount,
      payAmount: data.pay_amount,
      utr: data.utr,
      txnId: data.txn_id
    };
  } catch (err) {
    // ZapUPI returns 404 if the order_id isn't found yet — treat as still pending
    // rather than a hard failure, so the polling loop keeps retrying.
    if (err.response?.status === 404) {
      return { status: 'pending', verified: false };
    }
    console.error('ZapUPI order-status check failed:', err.response?.data || err.message);
    return null;
  }
}

/**
 * ZapUPI's flow has no manual "submit UTR" step — the customer pays on
 * ZapUPI's hosted payment_url page and ZapUPI verifies it on their end.
 * Kept as a no-op passthrough so any existing caller doesn't crash; the
 * real confirmation happens via checkVerificationStatus() polling or the
 * incoming webhook.
 */
async function submitUtr({ orderId }, settings = {}) {
  return { success: true, txnId: orderId, status: 'pending', verified: false };
}

/**
 * ZapUPI does not document a payment-history listing endpoint. Left as a
 * stub returning null so admin-panel callers degrade gracefully instead of
 * crashing on a request to a non-existent route.
 */
async function getPaymentHistory({ status, limit } = {}, settings = {}) {
  return null;
}

module.exports = {
  generateQr,
  submitUtr,
  checkVerificationStatus,
  getPaymentHistory
};
