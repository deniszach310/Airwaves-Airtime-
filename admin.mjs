import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { database, PostgresStore } from './store.mjs';
import { base32, normalizePhone, passwordHash, sealSeed } from './security.mjs';

const [username,number] = process.argv.slice(2);
if (!/^[a-z0-9][a-z0-9_.-]{2,39}$/.test(username || '') || !normalizePhone(number)) {
  throw new Error('Usage: node src/admin.mjs <lowercase-username> <dedicated-admin-phone>');
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/,'');
if (password.length < 16 || password.length > 128) throw new Error('Provide a password of 16–128 characters on stdin.');
const config = loadConfig();
const pool = database(config);
try {
  const store = new PostgresStore(pool);
  await store.migrate();
  const seed = randomBytes(20);
  await store.provisionAdmin(username,normalizePhone(number),await passwordHash(password),sealSeed(config.secret,seed));
  console.log('Add to an authenticator as a time-based key (6 digits, 30 seconds). Keep private:');
  console.log(base32(seed));
} finally { await pool.end(); }
