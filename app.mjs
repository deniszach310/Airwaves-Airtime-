import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { calculateAmountDue } from './pricing.mjs';
import { constantEqual, normalizePhone, openSeed, otpHash, passwordHash, totpStep, validPassword } from './security.mjs';
import { eventKey, parsePaymentCallback } from './workflow.mjs';
import { validId } from './providers.mjs';

const dist = new URL('../../dist/',import.meta.url);
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const states = new Set(['otp_pending','stk_dispatching','pending','paid','failed','uncertain','not_started','processing','delivered']);
const assets = {
  '/': ['index.html','text/html'], '/app.js':['app.js','text/javascript'],
  '/styles.css':['styles.css','text/css'], '/assets/airwaves-logo.png':['assets/airwaves-logo.png','image/png'],
  '/admin':['admin/index.html','text/html'], '/admin/':['admin/index.html','text/html'],
};
const customerView = user => ({name:user.full_name,phone:user.phone_e164,email:user.email});
const txView = (tx, admin = false) => ({
  id:tx.id, network:tx.network, airtimeAmount:Number(tx.airtime_amount), amountDue:Number(tx.amount_due),
  discount:Number(tx.discount_percent), payment:tx.payment_status, delivery:tx.fulfillment_status,
  receipt:tx.mpesa_receipt, environment:tx.payment_environment, created:tx.created_at, paid:tx.paid_at, delivered:tx.delivered_at,
  payer:tx.payer_e164, recipient:tx.recipient_e164,
  ...(admin ? {checkoutRequestId:tx.checkout_request_id,merchantRequestId:tx.merchant_request_id,
    providerId:tx.provider_request_id,failure:tx.failure_code,updated:tx.updated_at,accountStatus:tx.account_status} : {}),
});

class HttpError extends Error {
  constructor(status,message) { super(message); this.status = status; }
}
const reject = (status,message) => { throw new HttpError(status,message); };
const json = (res,status,data) => {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
};
async function body(req, formAllowed = false) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0];
  if (contentType !== 'application/json' && !(formAllowed && contentType === 'application/x-www-form-urlencoded')) reject(415,'Unsupported request format.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 20000) reject(413,'Request is too large.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (contentType === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw));
  let data;
  try { data = JSON.parse(raw); } catch { reject(400,'Invalid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) reject(400,'Expected a JSON object.');
  return data;
}
const text = (value, max = 200) => typeof value === 'string' && value.length <= max ? value.trim() : '';
const cookieName = (admin, secure) => (secure ? '__Host-' : '') + (admin ? 'airwaves_admin' : 'airwaves_customer');
function cookie(req,name) {
  const item = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(name+'='));
  const value = item?.slice(name.length+1) || '';
  return /^[\w-]{43}$/.test(value) ? value : '';
}
function filters(url) {
  const status = url.searchParams.get('status') || '';
  const cursor = url.searchParams.get('before') || '';
  const [created,id] = cursor.split('~');
  const validDate = value => /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value && Number(value.slice(0,4)) >= 2000;
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  const amount = url.searchParams.get('amount') || '';
  if ((status && !states.has(status)) ||
      (cursor && (!uuid.test(id || '') || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(created) || !Number.isFinite(Date.parse(created)))) ||
      (from && !validDate(from)) || (to && !validDate(to)) || (from && to && from>to) ||
      (amount && (!/^\d{2,5}$/.test(amount) || Number(amount)<10 || Number(amount)>10000))) reject(422,'Invalid transaction filters.');
  return { status, before:cursor ? {created,id} : null, from,to,amount };
}

export function createApp(config, store, providers) {
  const address = req => {
    const peer = req.socket.remoteAddress || '';
    const forwarded = req.headers['x-forwarded-for'];
    return config.behindProxy && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : peer;
  };
  async function limit(key,max,seconds) {
    if (!await store.rate(key,max,seconds)) reject(429,'Too many attempts. Please wait before trying again.');
  }
  async function signedIn(req,admin = false) {
    const token = cookie(req,cookieName(admin,config.secure));
    const user = token ? await store.session(token,admin) : null;
    if (!user) reject(401,'Please sign in.');
    return user;
  }
  function setCookie(res,admin,value,age) {
    res.setHeader('Set-Cookie',cookieName(admin,config.secure)+'='+value+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age+(config.secure ? '; Secure' : ''));
  }
  async function login(req,res,user,admin) {
    const seconds = admin ? 1800 : 7200;
    const name = cookieName(admin,config.secure);
    const previous = cookie(req,name);
    if (previous) await store.revoke(previous);
    const token = randomBytes(32).toString('base64url');
    await store.sessionCreate(user.id,token,admin,seconds);
    setCookie(res,admin,token,seconds);
  }
  function quote(input) {
    if (!config.purchasesEnabled) reject(503,'Airtime purchasing is temporarily unavailable.');
    const recipient = normalizePhone(input.recipient);
    const amount = typeof input.amount === 'number' || /^\d{1,5}$/.test(text(input.amount,5)) ? Number(input.amount) : NaN;
    const network = text(input.network,20);
    const service = Object.hasOwn(config.pricing,network) && config.pricing[network];
    if (!recipient || !service || !Number.isSafeInteger(amount) || amount < service.min || amount > service.max) reject(422,'Choose an available network, enter a valid Kenyan recipient and use the displayed amount range.');
    return {recipient,amount,network,discount:service.discount,due:calculateAmountDue(amount,service.discount)};
  }

  async function route(req,res) {
    const url = new URL(req.url,'http://localhost');
    const path = url.pathname;
    const method = req.method;
    if (method === 'POST' && path.startsWith('/api/v1/webhooks/')) {
      const payment = path === '/api/v1/webhooks/mpesa/stk';
      const airtime = path === '/api/v1/webhooks/airtime/banricom';
      if (!payment && !airtime) reject(404,'Endpoint not found.');
      const callback = payment ? config.mpesa.callback : config.banricom.callback;
      if (!callback || !constantEqual(url.searchParams.get('token'),callback.token)) reject(403,'Callback authentication failed.');
      const data = await body(req,airtime);
      const event = payment ? parsePaymentCallback(data) : {
        reference:data.requestId ?? url.searchParams.get('requestId'),
        payload:{status:text(data.status ?? url.searchParams.get('status'),80).toLowerCase()},
      };
      if (!event || !validId(event.reference) || (airtime && !event.payload.status)) reject(422,'Invalid callback fields.');
      await store.enqueue(payment ? 'stk' : 'airtime',event.reference,eventKey(event.payload),event.payload,config.mpesa.environment);
      return json(res,200,{ResultCode:0,ResultDesc:'Accepted'});
    }
    if (method === 'POST' && req.headers.origin !== config.origin) reject(403,'Request origin rejected.');
    if (method === 'GET' && path === '/api/v1/health') {
      await store.query('SELECT 1');
      return json(res,200,{status:'ok'});
    }
    if (method === 'GET' && path === '/api/v1/catalog') {
      return json(res,200,{enabled:config.purchasesEnabled,environment:config.mpesa.environment,
        networks:config.purchasesEnabled ? config.pricing : {}, support:config.supportEmail, terms:config.termsUrl,
        privacy:config.privacyUrl, termsVersion:config.termsVersion});
    }
    if (method === 'POST' && path === '/api/v1/auth/register') {
      await limit('register:'+address(req),8,600);
      const input = await body(req);
      const name = text(input.name,100);
      const phone = normalizePhone(input.phone);
      const email = text(input.email,254).toLowerCase();
      const password = input.password;
      if (!name || !phone || (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
        typeof password !== 'string' || password.length<12 || password.length>128) reject(422,'Enter a name, Kenyan phone, valid optional email and password of 12–128 characters.');
      let user;
      try { user = await store.register(name,phone,email || null,await passwordHash(password)); }
      catch (error) { if (error.code === '23505') reject(409,'That phone number or email is already registered.'); throw error; }
      await login(req,res,user,false);
      return json(res,201,{user:customerView(user)});
    }
    if (method === 'POST' && ['/api/v1/auth/login','/api/v1/admin/login'].includes(path)) {
      const admin = path.includes('/admin/');
      await limit('login:' + admin + ':' + address(req),20,300);
      const input = await body(req);
      const value = text(input.identifier,254).toLowerCase();
      const identity = admin || value.includes('@') ? value : normalizePhone(value);
      const password = input.password;
      if (!identity || typeof password !== 'string' || password.length>128) reject(401,'Invalid sign-in details.');
      await limit('login-id:'+admin+':'+identity,8,300);
      const user = admin ? await store.admin(identity) : await store.customer(identity);
      const passwordValid = await validPassword(password,user?.password_hash);
      if (!passwordValid || user?.account_status !== 'active') reject(401,'Invalid sign-in details.');
      if (admin) {
        const step = totpStep(openSeed(config.secret,user.admin_totp),text(input.code,6));
        if (step === null || !await store.claimAdminStep(user.id,step,user.password_hash,user.admin_totp)) reject(401,'Invalid or already used authenticator code.');
      }
      await login(req,res,user,admin);
      return json(res,200,{user:admin ? {name:user.admin_username} : customerView(user)});
    }
    if (method === 'POST' && ['/api/v1/auth/logout','/api/v1/admin/logout'].includes(path)) {
      const admin = path.includes('/admin/');
      const token = cookie(req,cookieName(admin,config.secure));
      if (token) await store.revoke(token);
      setCookie(res,admin,'',0);
      return json(res,200,{signedOut:true});
    }
    if (method === 'GET' && path === '/api/v1/me') return json(res,200,{user:customerView(await signedIn(req))});
    if (method === 'GET' && path === '/api/v1/admin/me') return json(res,200,{user:{name:(await signedIn(req,true)).admin_username}});
    if (method === 'POST' && path === '/api/v1/quotes') {
      await signedIn(req);
      return json(res,200,quote(await body(req)));
    }
    if (method === 'POST' && path === '/api/v1/otp/challenges') {
      const user = await signedIn(req);
      const input = await body(req);
      const order = quote(input);
      const payer = normalizePhone(input.payer);
      if (!payer || input.termsAccepted !== true || input.termsVersion !== config.termsVersion ||
          input.expectedAmountDue !== order.due || input.expectedDiscount !== order.discount) reject(409,'Check the payer number and review the current price and terms before proceeding.');
      await limit('otp-account:'+user.id,4,900);
      await limit('otp-ip:'+address(req),12,900);
      await limit('otp-payer:'+payer,4,900);
      const id = randomUUID();
      const code = String(randomInt(1000000)).padStart(6,'0');
      await store.createCheckout({...order,id,userId:user.id,payer,termsVersion:config.termsVersion,
        otpHash:otpHash(config.secret,id,code),environment:config.mpesa.environment});
      try { await providers.sendOtp({phone:payer.slice(1),amount:order.due,code}); }
      catch {
        await store.paymentError(id,'otp_pending','failed','OTP_DELIVERY_FAILED');
        reject(502,'The SMS provider did not confirm sending the code.');
      }
      await store.otpSent(id);
      return json(res,202,{id,expiresIn:300});
    }
    const verify = path.match(/^\/api\/v1\/otp\/challenges\/([^/]+)\/verify$/);
    if (method === 'POST' && verify && uuid.test(verify[1])) {
      const user = await signedIn(req);
      if (!config.purchasesEnabled) reject(503,'Airtime purchasing is temporarily unavailable.');
      await limit('verify:'+user.id,12,900);
      const input = await body(req);
      const code = text(input.code,6);
      const result = await store.verifyOtp(verify[1],user.id,expected => /^\d{6}$/.test(code) && constantEqual(otpHash(config.secret,verify[1],code),expected),config.mpesa.environment);
      if (!result) reject(409,'This code has expired or was already used. Check your account for an existing payment request.');
      if (!result.correct) reject(422,result.row.failed_attempts >= 3 ? 'Account restricted after three incorrect codes. Contact support.' : 'Incorrect code. ' + (3-result.row.failed_attempts) + ' attempts left.');
      let refs;
      try { refs = await providers.requestStk({id:result.row.id,payer:result.row.payer_e164,amountDue:Number(result.row.amount_due)}); }
      catch {
        await store.paymentError(result.row.id,'stk_dispatching','uncertain','PAYMENT_REVIEW_REQUIRED');
        return json(res,202,{id:result.row.id,payment:'uncertain'});
      }
      await store.stkAccepted(result.row.id,refs.checkoutRequestId,refs.merchantRequestId);
      return json(res,202,{id:result.row.id,payment:'pending'});
    }
    const list = path === '/api/v1/transactions' || path === '/api/v1/admin/transactions';
    const transaction = path.match(/^\/api\/v1\/(admin\/)?transactions\/([^/]+)(?:\/(query|note|unlock))?$/);
    if (method === 'GET' && list) {
      const admin = path.includes('/admin/');
      const user = await signedIn(req,admin);
      const filter = filters(url);
      const { rows,summary } = await store.transactions(admin ? null : user.id,filter);
      const last = rows[49];
      return json(res,200,{transactions:rows.slice(0,50).map(tx => txView(tx,admin)),
        next:rows.length>50 ? last.cursor_created+'~'+last.id : null,
        ...(summary ? {summary:{matches:Number(summary.matches),matched:Number(summary.matched_airtime),delivered:Number(summary.delivered_airtime),
          from:filter.from,to:filter.to}} : {})});
    }
    if (transaction && uuid.test(transaction[2])) {
      const [,scope,id,action] = transaction;
      const admin = Boolean(scope);
      const user = await signedIn(req,admin);
      const tx = await store.transaction(id,admin ? null : user.id);
      if (!tx) reject(404,'Transaction not found.');
      if (method === 'GET' && !action) return json(res,200,{transaction:txView(tx,admin),...(admin ? {audit:await store.auditHistory(id)} : {})});
      if (admin && method === 'POST' && action === 'note') {
        const note = text((await body(req)).note,500);
        if (!note) reject(422,'Enter a note of 1–500 characters.');
        await store.audit(user.id,id,'note',note);
        return json(res,201,{saved:true});
      }
      if (admin && method === 'POST' && action === 'unlock') {
        const reason = text((await body(req)).note,500);
        if (!reason) reject(422,'Enter a reason before unlocking this account.');
        if (!await store.releaseRestriction(id,user.id,reason)) reject(409,'This account restriction cannot be released from this transaction.');
        return json(res,200,{unlocked:true});
      }
      if (admin && method === 'POST' && action === 'query') {
        await limit('requery:'+user.id,10,300);
        if (!config.mpesa.callback || tx.payment_environment !== config.mpesa.environment || !tx.checkout_request_id) reject(409,'A matching Daraja environment and checkout reference are required.');
        let result;
        try { result = await providers.queryStk(tx.checkout_request_id); }
        catch { reject(502,'Daraja did not return a confirmed result.'); }
        if (result.merchantRequestId !== tx.merchant_request_id) reject(409,'Daraja merchant reference did not match.');
        await store.audit(user.id,id,'daraja_query','Daraja result ' + result.resultCode);
        return json(res,200,{resultCode:result.resultCode});
      }
    }
    if (method === 'GET' && Object.hasOwn(assets,path)) {
      const [file,type] = assets[path];
      res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store',...(path.startsWith('/admin') ? {'X-Robots-Tag':'noindex, nofollow'} : {})});
      return res.end(await readFile(new URL(file,dist)));
    }
    reject(404,'Page or endpoint not found.');
  }

  return createServer((req,res) => {
    res.setHeader('Content-Security-Policy',"default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    if (config.secure) res.setHeader('Strict-Transport-Security','max-age=31536000');
    route(req,res).catch(error => {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) return json(res,error.status,{message:error.message});
      console.error('AIRWAVES request failed',error.code || error.name);
      return json(res,500,{message:'Something went wrong. Check your account before trying a payment again.'});
    });
  });
}
