import { createHash } from 'node:crypto';
import { parseWholeKes } from './pricing.mjs';
import { normalizePhone } from './security.mjs';
import { validId } from './providers.mjs';

export function parsePaymentCallback(body) {
  const cb = body?.Body?.stkCallback;
  if (!validId(cb?.CheckoutRequestID) || !validId(cb.MerchantRequestID) || !/^\d{1,10}$/.test(String(cb.ResultCode))) return null;
  const payload = { merchant:cb.MerchantRequestID, result:String(cb.ResultCode) };
  if (payload.result === '0') {
    const items = cb.CallbackMetadata?.Item;
    if (!Array.isArray(items)) return null;
    const fields = Object.fromEntries(items.filter(x => x && typeof x.Name === 'string').map(x => [x.Name,x.Value]));
    payload.amount = parseWholeKes(fields.Amount);
    payload.phone = normalizePhone(fields.PhoneNumber);
    payload.receipt = fields.MpesaReceiptNumber;
    if (payload.amount === null || !payload.phone || typeof payload.receipt !== 'string' || !/^[A-Z0-9]{8,30}$/.test(payload.receipt)) return null;
  }
  return { reference:cb.CheckoutRequestID, payload };
}
export function eventKey(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function createWorker(store, providers, config) {
  let running = false;
  let lastMaintenance = 0;

  async function processPayment(event) {
    const tx = await store.byRequest(event.provider_ref,event.environment);
    if (!tx) return null;
    const data = event.payload;
    if (tx.merchant_request_id !== data.merchant) return 'MERCHANT_MISMATCH';
    if (data.result !== '0') {
      await store.paymentError(tx.id,['pending','uncertain'],'failed','MPESA_' + data.result);
      return 'FAILURE_RECORDED';
    }
    if (Number(tx.amount_due) !== data.amount || tx.payer_e164 !== data.phone) return 'PAYMENT_DETAILS_MISMATCH';
    if (tx.payment_status === 'paid') return tx.mpesa_receipt === data.receipt ? 'DUPLICATE' : 'RECEIPT_MISMATCH';
    // The token authenticates access to the callback URL. The authenticated
    // outbound Daraja query independently confirms the payment before fulfilment.
    const query = await providers.queryStk(event.provider_ref);
    if (query.merchantRequestId !== data.merchant) return 'QUERY_MERCHANT_MISMATCH';
    if (query.resultCode !== '0') return null;
    return await store.confirmPayment(tx.id,data.receipt) ? 'PAYMENT_CONFIRMED' : 'RECEIPT_CONFLICT_OR_DUPLICATE';
  }

  async function processAirtime(event) {
    const tx = await store.byProvider(event.provider_ref);
    if (!tx) return null;
    if (['delivered','failed'].includes(tx.fulfillment_status)) return 'ALREADY_FINAL';
    const status = event.payload.status;
    const delivered = config.banricom.deliveredStatuses.includes(status);
    if (!delivered && !config.banricom.failedStatuses.includes(status)) return 'NON_TERMINAL_OR_UNKNOWN';
    await store.delivery(tx.id,delivered ? 'delivered' : 'failed',null,delivered ? null : 'BANRICOM_DELIVERY_FAILED');
    return 'DELIVERY_RECORDED';
  }

  return async function tick() {
    if (running) return;
    running = true;
    try {
      if (Date.now() - lastMaintenance >= 60000) {
        await store.maintain();
        lastMaintenance = Date.now();
      }
      if (!config.mpesa.callback) return;
      for (const event of await store.events(config.mpesa.environment)) {
        let result;
        try { result = event.kind === 'stk' ? await processPayment(event) : await processAirtime(event); }
        catch { result = null; }
        if (result == null && Date.now() - new Date(event.created_at).getTime() > 24*60*60*1000) result = 'RECONCILIATION_REQUIRED';
        await store.recordEvent(event,result ?? null);
      }
      if (config.mpesa.environment !== 'live') return;
      const tx = await store.claimDelivery();
      if (!tx) return;
      let result;
      try {
        result = await providers.deliverAirtime({ network:tx.network,recipient:tx.recipient_e164,amount:Number(tx.airtime_amount) });
      } catch {
        // A timeout can mean the provider has already credited the recipient.
        await store.delivery(tx.id,'uncertain',null,'DELIVERY_REVIEW_REQUIRED');
        return;
      }
      await store.delivery(tx.id,result.pending ? 'processing' : 'delivered',result.providerId,null);
    } finally {
      running = false;
    }
  };
}
