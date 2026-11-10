import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(derive);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function constantEqual(a,b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x,y);
}
export async function passwordHash(password) {
  const salt = randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + (await scrypt(password,salt,64)).toString('hex');
}
export async function validPassword(password, record) {
  const [,salt,expected] = String(record ?? '').split('$');
  const actual = await scrypt(password,Buffer.from(salt || '0'.repeat(32),'hex'),64);
  return constantEqual(actual.toString('hex'),expected);
}
export function normalizePhone(input) {
  const v = String(input ?? '').trim().replace(/[\s()-]/g,'');
  if (/^0[17]\d{8}$/.test(v)) return '+254' + v.slice(1);
  if (/^\+?254[17]\d{8}$/.test(v)) return '+' + v.slice(-12);
  return '';
}
export function otpHash(secret,id,code) {
  return createHmac('sha256',secret).update('checkout-otp:' + id + ':' + code).digest('hex');
}
const seedKey = secret => createHash('sha256').update('admin-totp:' + secret).digest();
export function sealSeed(secret, seed) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',seedKey(secret),nonce);
  const encrypted = Buffer.concat([cipher.update(seed),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url');
}
export function openSeed(secret, sealed) {
  const packed = Buffer.from(sealed,'base64url');
  const decipher = createDecipheriv('aes-256-gcm',seedKey(secret),packed.subarray(0,12));
  decipher.setAuthTag(packed.subarray(12,28));
  return Buffer.concat([decipher.update(packed.subarray(28)),decipher.final()]);
}
export function base32(seed) {
  const bits = [...seed].map(b => b.toString(2).padStart(8,'0')).join('');
  return (bits.match(/.{1,5}/g) || []).map(b => alphabet[parseInt(b.padEnd(5,'0'),2)]).join('');
}
export function totpStep(seed, code, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now/30000);
  for (const n of [step,step-1,step+1]) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(n));
    const digest = createHmac('sha1',seed).update(counter).digest();
    const offset = digest[19] & 15;
    const value = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6,'0');
    if (constantEqual(value,code)) return n;
  }
  return null;
}
