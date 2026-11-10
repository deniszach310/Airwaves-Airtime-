async function jsonRequest(fetcher, url, headers, data) {
  const response = await fetcher(url, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Accept: 'application/json', ...headers, ...(data === undefined ? {} : {'Content-Type': 'application/json'}) },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(12000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('PROVIDER_HTTP_' + response.status);
  const body = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_PROVIDER_RESPONSE');
  return body;
}

const eat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
export function mpesaTimestamp(date = new Date()) {
  const parts = Object.fromEntries(eat.formatToParts(date).map(({type,value}) => [type,value]));
  return parts.year + parts.month + parts.day + parts.hour + parts.minute + parts.second;
}

export function createProviders(config, fetcher = fetch) {
  const c = config.mpesa;
  const base = c.environment === 'live' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  const request = (url, headers, data) => jsonRequest(fetcher, url, headers, data);
  const bearer = token => ({ Authorization: 'Bearer ' + token });
  const basic = (key, secret) => ({ Authorization: 'Basic ' + Buffer.from(key + ':' + secret).toString('base64') });
  const cache = new Map();
  async function token(url, headers, field) {
    const saved = cache.get(url);
    if (saved?.until > Date.now()) return saved.token;
    const body = await request(url, headers);
    if (typeof body[field] !== 'string' || !body[field]) throw new Error('PROVIDER_TOKEN_MISSING');
    const lifetime = Number(body.expires_in);
    if (Number.isFinite(lifetime) && lifetime > 30) cache.set(url, { token: body[field], until: Date.now() + (lifetime - 30) * 1000 });
    return body[field];
  }
  async function daraja(path, data) {
    const t = await token(base + '/oauth/v1/generate?grant_type=client_credentials', basic(c.key,c.secret), 'access_token');
    const stamp = mpesaTimestamp();
    return request(base + path, bearer(t), {
      BusinessShortCode: c.shortcode, Password: Buffer.from(c.shortcode + c.passkey + stamp).toString('base64'), Timestamp: stamp, ...data,
    });
  }
  return {
    async sendOtp({ phone, amount, code }) {
      const sms = config.sms;
      const body = await request(sms.url, {'X-App-ID': sms.appId, 'X-API-Key': sms.apiKey}, {
        message: 'Your AIRWAVES verification code is ' + code + '. Valid for 5 minutes. Payment: KES ' + amount + '. Never share this code.',
        shortcode: sms.shortcode, msisdn: phone,
      });
      const accepted = sms.acceptancePath.split('.').reduce((current, key) => current && Object.hasOwn(current,key) ? current[key] : undefined, body);
      if (body.success === false || accepted == null || String(accepted) !== sms.acceptanceValue) throw new Error('SMS_NOT_ACCEPTED');
    },
    async requestStk({ id, payer, amountDue }) {
      const body = await daraja('/mpesa/stkpush/v1/processrequest', {
        TransactionType: c.transactionType, Amount: amountDue, PartyA: payer.slice(1), PartyB: c.partyB,
        PhoneNumber: payer.slice(1), CallBackURL: c.callback.url, AccountReference: id.replaceAll('-','').slice(0,12), TransactionDesc: 'Airtime purchase',
      });
      if (String(body.ResponseCode) !== '0' || !validId(body.CheckoutRequestID) || !validId(body.MerchantRequestID)) throw new Error('STK_NOT_ACCEPTED');
      return { checkoutRequestId: body.CheckoutRequestID, merchantRequestId: body.MerchantRequestID };
    },
    async queryStk(checkoutRequestId) {
      const body = await daraja('/mpesa/stkpushquery/v1/query', { CheckoutRequestID: checkoutRequestId });
      if (String(body.ResponseCode) !== '0' || body.CheckoutRequestID !== checkoutRequestId || !validId(body.MerchantRequestID) || !/^\d{1,10}$/.test(String(body.ResultCode))) throw new Error('STK_QUERY_UNCONFIRMED');
      return { resultCode: String(body.ResultCode), merchantRequestId: body.MerchantRequestID };
    },
    async deliverAirtime({ network, recipient, amount }) {
      if (c.environment !== 'live') throw new Error('PRODUCTION_FULFILMENT_REQUIRES_LIVE_PAYMENT');
      if (network === 'safaricom') {
        const s = config.safaricom;
        const t = await token('https://api.safaricom.co.ke/oauth2/v3/generate?grant_type=client_credentials', basic(s.key,s.secret), 'access_token');
        const body = await request('https://api.safaricom.co.ke/v1/pretups/api/recharge', bearer(t), {
          senderMsisdn: s.sender, amount: amount * 100, servicePin: s.pin, receiverMsisdn: recipient.slice(-9),
        });
        if (String(body.responseStatus) !== s.acceptanceValue || !validId(String(body.transId ?? ''))) throw new Error('ETOPUP_UNCONFIRMED');
        return { providerId: String(body.transId), pending: false };
      }
      const b = config.banricom;
      const t = await token('https://reseller.banricom.com/api/v1.0/generate_token', {Authorization:b.authorization}, 'token');
      const body = await request('https://reseller.banricom.com/api/v1.0/airtime', {...bearer(t), Passkey:b.passkey}, {
        Type:'single', Mobile:recipient.slice(1), Amount:amount, CallBackUrl:b.callback.url,
      });
      if (String(body.statusCode) !== b.acceptanceValue || !validId(String(body.requestId ?? ''))) throw new Error('AIRTIME_UNCONFIRMED');
      return { providerId: String(body.requestId), pending: true };
    },
  };
}
export function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}
