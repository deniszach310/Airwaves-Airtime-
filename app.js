'use strict';

const admin = document.body.dataset.page === 'admin';
const scope = admin ? '/admin' : '';
const authPath = admin ? '/admin' : '/auth';
const byId = id => document.getElementById(id);
const formData = form => Object.fromEntries(new FormData(form));
const kes = number => 'KES ' + new Intl.NumberFormat('en-KE').format(number);
const date = value => value ? new Intl.DateTimeFormat('en-KE', {
  dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Nairobi',
}).format(new Date(value)) + ' EAT' : '—';
const networks = {safaricom:'Safaricom',airtel:'Airtel',telkom:'Telkom',jtl:'JTL / Faiba'};
const paymentLabels = {
  otp_pending:'Awaiting SMS verification',stk_dispatching:'Sending M-Pesa request',pending:'Waiting for M-Pesa confirmation',
  paid:'Payment confirmed',failed:'Payment or verification failed',uncertain:'Payment needs review',
};
const deliveryLabels = {
  not_started:'Awaiting fulfilment',processing:'Delivery in progress',delivered:'Airtime delivered',
  failed:'Delivery failed',uncertain:'Delivery needs review',
};
let catalog, session, currentQuote, challenge, cursor, timer, opened, listVersion = 0;

function node(tag,text,className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function notice(message = '',error = false) {
  byId('status').textContent = message;
  byId('status').classList.toggle('error',error);
}
async function api(path,payload) {
  const response = await fetch('/api/v1'+path,payload === undefined ? {} : {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.message || 'Request failed.');
    error.status = response.status;
    if (error.status === 401 && session) showSession(null);
    throw error;
  }
  return data;
}
function action(button,run) {
  return async event => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    notice();
    try { await run(); }
    catch (error) { notice(error.message,true); }
    finally { button.disabled = false; }
  };
}
function bindForm(id,run) {
  const form = byId(id);
  form.addEventListener('submit',action(form.querySelector('button'),() => run(form)));
}
function bindButton(id,run) {
  const button = byId(id);
  button.addEventListener('click',action(button,run));
}
function fields(rows) {
  const list = node('dl');
  for (const [key,value] of rows) list.append(node('dt',key),node('dd',value ?? '—'));
  return list;
}
function externalLink(label,url) {
  const link = node('a',label);
  link.href = url;
  return link;
}
function showSession(user) {
  session = user;
  byId('auth').hidden = Boolean(user);
  byId('session').hidden = !user;
  byId('profile').textContent = user ? [user.name,user.phone,user.email].filter(Boolean).join(' · ') : '';
  opened = null;
  clearTimeout(timer);
  byId('detail').hidden = true;
  byId('orders').replaceChildren();
  byId('more').hidden = true;
  listVersion++;
  if (!admin) resetCheckout();
}
async function loadList(older = false) {
  const version = ++listVersion;
  const params = new URLSearchParams(admin ? formData(byId('filters')) : {});
  if (older && cursor) params.set('before',cursor);
  const data = await api(scope+'/transactions?'+params);
  if (version !== listVersion || !session) return;
  const list = byId('orders');
  if (!older) list.replaceChildren();
  if (!data.transactions.length && !older) list.append(node('li','No transactions match.'));
  for (const tx of data.transactions) {
    const item = node('li');
    const info = node('div');
    info.append(node('strong',kes(tx.airtimeAmount)+' · '+networks[tx.network]),node('small',
      date(tx.created)+' · '+paymentLabels[tx.payment] + (tx.environment === 'sandbox' ? ' · Sandbox' : tx.payment === 'paid' ? ' · '+deliveryLabels[tx.delivery] : '')));
    const open = node('button','View','secondary');
    open.type = 'button';
    open.addEventListener('click',action(open,() => showDetail(tx.id,true)));
    item.append(info,open);
    list.append(item);
  }
  if (admin) {
    const { matches,matched,delivered,from,to } = data.summary;
    const period = from || to ? (from || 'Any start')+' to '+(to || 'today')+' EAT' : 'All dates';
    byId('register-summary').textContent = period+' · '+matches+' matches · '+kes(matched)+' in matched airtime · '+kes(delivered)+' delivered';
  }
  cursor = data.next;
  byId('more').hidden = !cursor;
}
async function showDetail(id,focus = false) {
  clearTimeout(timer);
  opened = id;
  const data = await api(scope+'/transactions/'+id);
  if (opened !== id || !session) return;
  const tx = data.transaction;
  const detail = byId('detail');
  const receipt = tx.payment === 'paid' && tx.delivery === 'delivered' && tx.environment !== 'sandbox';
  const rows = [
    ['Order reference',tx.id], ['Created',date(tx.created)], ['Network',networks[tx.network]],
    ['Payer',tx.payer], ['Recipient',tx.recipient], ['Airtime',kes(tx.airtimeAmount)], ['Payable',kes(tx.amountDue)],
    ['Payment',paymentLabels[tx.payment]], ['Delivery',tx.environment === 'sandbox' ? 'No live airtime in Daraja sandbox' : deliveryLabels[tx.delivery]],
  ];
  if (tx.receipt) rows.push(['M-Pesa reference',tx.receipt]);
  if (tx.paid) rows.push(['Payment confirmed at',date(tx.paid)]);
  if (tx.delivered) rows.push(['Delivered at',date(tx.delivered)]);
  if (admin) rows.push(['Environment',tx.environment || 'Prior release'],['Checkout ID',tx.checkoutRequestId],
    ['Merchant ID',tx.merchantRequestId],['Airtime reference',tx.providerId],['Review code',tx.failure],['Account status',tx.accountStatus],['Last update',date(tx.updated)]);
  detail.replaceChildren(node('h3',receipt ? 'AIRWAVES airtime receipt' : 'Transaction details'),fields(rows));
  if (tx.payment === 'uncertain' || tx.delivery === 'uncertain') detail.append(node('p','Check the M-Pesa message and contact support with the order reference before attempting the same purchase again.'));
  if (!admin && receipt) {
    const print = node('button','Print receipt','secondary');
    print.addEventListener('click',() => window.print());
    detail.append(print);
  }
  if (admin) {
    if (tx.checkoutRequestId) {
      const query = node('button','Query Daraja','secondary');
      query.addEventListener('click',action(query,async () => {
        const answer = await api(scope+'/transactions/'+id+'/query',{});
        await showDetail(id);
        notice('Daraja result code '+answer.resultCode+'. Query recorded in the audit trail.');
      }));
      detail.append(query);
    }
    const note = node('form');
    const label = node('label','Reconciliation note');
    const field = node('textarea');
    field.required = true; field.maxLength = 500;
    label.append(field);
    const save = node('button','Save note');
    note.append(label,save);
    note.addEventListener('submit',action(save,async () => {
      await api(scope+'/transactions/'+id+'/note',{note:field.value});
      await showDetail(id);
      notice('Note saved.');
    }));
    if (tx.accountStatus === 'restricted' && tx.failure === 'OTP_ATTEMPTS_EXCEEDED') {
      const unlock = node('button','Unlock account','secondary');
      unlock.type = 'button';
      unlock.addEventListener('click',action(unlock,async () => {
        if (!field.value.trim()) { field.focus(); throw new Error('Enter a reconciliation note with the reason for unlocking this account.'); }
        await api(scope+'/transactions/'+id+'/unlock',{note:field.value});
        await showDetail(id);
        notice('Account unlocked. The customer can sign in again.');
      }));
      note.append(unlock);
    }
    const audit = node('ul');
    for (const event of data.audit) audit.append(node('li',date(event.created_at)+' · '+event.admin_username+' · '+event.action+' · '+event.detail));
    detail.append(node('h3','Audit trail'),note,audit);
  }
  detail.hidden = false;
  if (focus) detail.focus();
  if (!admin && ['pending','stk_dispatching','processing'].some(state => tx.payment === state || tx.delivery === state)) {
    timer = setTimeout(async () => {
      try { await showDetail(id); await loadList(); } catch (error) { notice(error.message,true); }
    },5000);
  }
}
function resetCheckout() {
  currentQuote = null;
  challenge = null;
  byId('quote').hidden = !catalog?.enabled;
  byId('checkout-unavailable').hidden = Boolean(catalog?.enabled);
  byId('confirm').hidden = true;
  byId('verify').hidden = true;
  byId('confirm').reset();
  byId('verify').reset();
}
async function loadCatalog() {
  catalog = await api('/catalog');
  byId('availability').textContent = !catalog.enabled ? 'Purchases are temporarily unavailable.' :
    catalog.environment === 'sandbox' ? 'Daraja sandbox is active. Live airtime delivery is disabled.' : 'Purchasing is open for the networks below.';
  const form = byId('quote');
  const choose = form.elements.network;
  for (const key of Object.keys(catalog.networks)) {
    const option = node('option',networks[key]);
    option.value = key;
    choose.append(option);
    byId('network-summary').append(node('span',networks[key]));
  }
  function range() {
    const service = catalog.networks[choose.value];
    if (!service) return;
    form.elements.amount.min = service.min;
    form.elements.amount.max = service.max;
    byId('amount-range').textContent = kes(service.min)+' to '+kes(service.max)+' per order';
  }
  choose.addEventListener('change',range);
  range();
  for (const [label,url] of [['Purchase terms',catalog.terms],['Privacy notice',catalog.privacy],['Support',catalog.support ? 'mailto:'+catalog.support : '']]) {
    if (url) byId('links').append(externalLink(label,url));
  }
  if (catalog.terms) byId('checkout-terms').href = catalog.terms;
}
bindForm('login',async form => {
  const data = await api(authPath+'/login',formData(form));
  form.reset();
  showSession(data.user);
  await loadList();
});
bindButton('logout',async () => {
  await api(authPath+'/logout',{});
  showSession(null);
  notice('Signed out.');
});
bindButton('refresh',async () => { await loadList(); if (opened) await showDetail(opened); });
bindButton('more',() => loadList(true));
if (admin) {
  bindForm('filters',() => loadList());
} else {
  bindForm('register',async form => {
    const data = await api('/auth/register',formData(form));
    form.reset();
    showSession(data.user);
    await loadList();
  });
  bindForm('quote',async form => {
    const input = formData(form);
    const price = await api('/quotes',input);
    currentQuote = {...input,expectedAmountDue:price.due,expectedDiscount:price.discount,termsVersion:catalog.termsVersion};
    byId('quote-summary').replaceChildren(fields([
      ['Network',networks[price.network]],['Recipient',price.recipient],['M-Pesa payer',input.payer],
      ['Airtime',kes(price.amount)],['Discount rate',price.discount+'%'],['You will pay',kes(price.due)],
    ]));
    byId('quote').hidden = true;
    byId('confirm').hidden = false;
  });
  bindForm('confirm',async form => {
    challenge = (await api('/otp/challenges',{...currentQuote,termsAccepted:form.elements.terms.checked})).id;
    byId('confirm').hidden = true;
    byId('verify').hidden = false;
    byId('verify').elements.code.focus();
  });
  bindForm('verify',async form => {
    const data = await api('/otp/challenges/'+challenge+'/verify',formData(form));
    resetCheckout();
    notice(data.payment === 'pending' ? 'Approve the M-Pesa prompt on the payer’s phone.' : 'Payment outcome is uncertain. Check the transaction before trying again.');
    await loadList();
    await showDetail(data.id,true);
  });
  for (const reset of document.querySelectorAll('[data-reset]')) reset.addEventListener('click',() => resetCheckout());
}
(async () => {
  if (!admin) {
    try { await loadCatalog(); } catch { byId('availability').textContent = 'Service availability could not be checked.'; }
  }
  try {
    const result = await api(admin ? '/admin/me' : '/me');
    showSession(result.user);
    await loadList();
  } catch (error) {
    if (!session) showSession(null);
    if (error.status !== 401) notice(error.message,true);
  }
})();
