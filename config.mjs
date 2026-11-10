import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export function loadConfig(env = process.env) {
  const value = (key, fallback = '') => String(env[key] ?? fallback).trim();
  const requireValues = (...keys) => {
    const missing = keys.filter(key => !value(key) || /^(replace|your_|<)/i.test(value(key)));
    if (missing.length) throw new Error('Missing configuration: ' + missing.join(', '));
  };
  const flag = key => {
    const v = value(key, 'false');
    if (!['true', 'false'].includes(v)) throw new Error(key + ' must be true or false.');
    return v === 'true';
  };
  const httpsUrl = key => {
    const url = new URL(value(key));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(key + ' requires an HTTPS URL.');
    return url;
  };
  requireValues('DATABASE_URL', 'PUBLIC_ORIGIN', 'SESSION_SECRET');
  const databaseUrl = new URL(value('DATABASE_URL'));
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
      [...databaseUrl.searchParams.keys()].some(key => /^ssl|^uselibpqcompat$/i.test(key))) {
    throw new Error('DATABASE_URL must be PostgreSQL. Configure TLS outside the URL.');
  }
  const origin = new URL(value('PUBLIC_ORIGIN'));
  const local = flag('LOCAL_HTTP');
  if ((origin.protocol !== 'https:' && !(local && origin.protocol === 'http:' && ['localhost','127.0.0.1'].includes(origin.hostname))) ||
      origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('PUBLIC_ORIGIN must be the site origin using HTTPS (or explicit local HTTP).');
  const secret = value('SESSION_SECRET');
  if (secret.length < 32) throw new Error('SESSION_SECRET requires at least 32 characters.');
  const enabled = flag('PURCHASES_ENABLED');
  const mpesaEnvironment = value('MPESA_ENVIRONMENT', 'sandbox');
  if (!['sandbox','live'].includes(mpesaEnvironment)) throw new Error('MPESA_ENVIRONMENT must be sandbox or live.');
  const transactionType = value('MPESA_TRANSACTION_TYPE','CustomerPayBillOnline');
  if (!['CustomerPayBillOnline','CustomerBuyGoodsOnline'].includes(transactionType)) throw new Error('Invalid MPESA_TRANSACTION_TYPE.');
  const networks = [...new Set(value('ENABLED_NETWORKS').split(',').map(x => x.trim()).filter(Boolean))];
  if (networks.some(x => !['safaricom','airtel','telkom','jtl'].includes(x))) throw new Error('Invalid ENABLED_NETWORKS.');
  const pricing = Object.fromEntries(networks.map(network => {
    const prefix = 'AIRWAVES_' + network.toUpperCase();
    const discountText = value(prefix + '_DISCOUNT', '0');
    const discount = Number(discountText);
    const min = Number(value(prefix + '_MIN', '10'));
    const max = Number(value(prefix + '_MAX', '10000'));
    if (!/^\d{1,3}(?:\.\d{1,4})?$/.test(discountText) || !(discount >= 0 && discount < 100) || !Number.isInteger(min) || !Number.isInteger(max) || min < 10 || max > 10000 || min > max) throw new Error('Invalid pricing for ' + network);
    return [network, { discount, min, max }];
  }));
  const callback = (key, path) => {
    requireValues(key);
    const token = value(key);
    if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error(key + ' must be at least 32 URL-safe characters.');
    return { token, url: origin.origin + path + '?token=' + token };
  };
  const port = Number(value('PORT','8787'));
  const supportEmail = value('SUPPORT_EMAIL');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  if (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) throw new Error('Invalid SUPPORT_EMAIL.');
  const termsUrl = value('TERMS_URL') ? httpsUrl('TERMS_URL').href : '';
  const privacyUrl = value('PRIVACY_URL') ? httpsUrl('PRIVACY_URL').href : '';
  let paymentCallback, airtimeCallback, smsUrl;
  const statuses = key => value(key).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const deliveredStatuses = statuses('BANRICOM_DELIVERED_STATUS_VALUES');
  const failedStatuses = statuses('BANRICOM_FAILED_STATUS_VALUES');
  if (enabled) {
    if (local || !networks.length) throw new Error('Purchases require HTTPS and at least one enabled network.');
    requireValues('SUPPORT_EMAIL','TERMS_URL','PRIVACY_URL','TERMS_VERSION','MPESA_CONSUMER_KEY','MPESA_CONSUMER_SECRET','MPESA_SHORTCODE','MPESA_PASSKEY','MPESA_PARTY_B',
      'BANRICOM_SMS_URL','BANRICOM_SMS_APP_ID','BANRICOM_SMS_API_KEY','BANRICOM_SMS_SHORTCODE','BANRICOM_SMS_ACCEPTANCE_PATH','BANRICOM_SMS_ACCEPTANCE_VALUE');
    if (![value('MPESA_SHORTCODE'),value('MPESA_PARTY_B')].every(x => /^\d{5,12}$/.test(x))) throw new Error('Invalid M-Pesa shortcode or PartyB.');
    smsUrl = httpsUrl('BANRICOM_SMS_URL').href;
    paymentCallback = callback('MPESA_CALLBACK_TOKEN','/api/v1/webhooks/mpesa/stk');
    if (mpesaEnvironment === 'live' && networks.includes('safaricom')) {
      requireValues('SAFARICOM_CONSUMER_KEY','SAFARICOM_CONSUMER_SECRET','SAFARICOM_SENDER','SAFARICOM_SERVICE_PIN','SAFARICOM_ACCEPTANCE_VALUE');
    }
    if (mpesaEnvironment === 'live' && networks.some(x => x !== 'safaricom')) {
      requireValues('BANRICOM_AUTHORIZATION','BANRICOM_PASSKEY','BANRICOM_ACCEPTANCE_VALUE','BANRICOM_DELIVERED_STATUS_VALUES','BANRICOM_FAILED_STATUS_VALUES');
      if (deliveredStatuses.some(x => failedStatuses.includes(x))) throw new Error('Banricom terminal statuses overlap.');
      airtimeCallback = callback('BANRICOM_CALLBACK_TOKEN','/api/v1/webhooks/airtime/banricom');
    }
  }
  if (enabled && mpesaEnvironment === 'live') {
    // Keep callbacks and accepted delivery jobs operational during a checkout pause.
    if (!flag('PROVIDERS_ENABLED')) throw new Error('Live checkout requires PROVIDERS_ENABLED=true.');
  }
  const providersEnabled = enabled || flag('PROVIDERS_ENABLED');
  if (providersEnabled && !enabled) {
    return { ...loadConfig({ ...env, PURCHASES_ENABLED: 'true' }), purchasesEnabled: false };
  }
  return {
    port, databaseUrl: value('DATABASE_URL'), dbTls: !flag('DB_PRIVATE_NO_TLS'),
    origin: origin.origin, secure: origin.protocol === 'https:', behindProxy: flag('TRUST_CADDY_PROXY'),
    secret, purchasesEnabled: enabled, pricing, supportEmail, termsUrl, privacyUrl, termsVersion: value('TERMS_VERSION'),
    mpesa: { environment: mpesaEnvironment, transactionType, key: value('MPESA_CONSUMER_KEY'), secret: value('MPESA_CONSUMER_SECRET'),
      shortcode: value('MPESA_SHORTCODE'), passkey: value('MPESA_PASSKEY'), partyB: value('MPESA_PARTY_B'), callback: paymentCallback },
    sms: { url: smsUrl, appId: value('BANRICOM_SMS_APP_ID'), apiKey: value('BANRICOM_SMS_API_KEY'), shortcode: value('BANRICOM_SMS_SHORTCODE'),
      acceptancePath: value('BANRICOM_SMS_ACCEPTANCE_PATH'), acceptanceValue: value('BANRICOM_SMS_ACCEPTANCE_VALUE') },
    safaricom: { key: value('SAFARICOM_CONSUMER_KEY'), secret: value('SAFARICOM_CONSUMER_SECRET'), sender: value('SAFARICOM_SENDER'),
      pin: value('SAFARICOM_SERVICE_PIN'), acceptanceValue: value('SAFARICOM_ACCEPTANCE_VALUE') },
    banricom: { authorization: value('BANRICOM_AUTHORIZATION'), passkey: value('BANRICOM_PASSKEY'), acceptanceValue: value('BANRICOM_ACCEPTANCE_VALUE'),
      callback: airtimeCallback, deliveredStatuses, failedStatuses },
  };
}
