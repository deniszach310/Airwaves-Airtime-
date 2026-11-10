import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { calculateAmountDue,parseWholeKes } from '../src/pricing.mjs';
import { constantEqual,normalizePhone,otpHash,openSeed,sealSeed,totpStep } from '../src/security.mjs';
import { mpesaTimestamp } from '../src/providers.mjs';
import { parsePaymentCallback } from '../src/workflow.mjs';

test('whole-shilling prices and callback amounts',() => {
  assert.equal(calculateAmountDue(100,7.444),93);
  assert.equal(calculateAmountDue(1013,9.14),921);
  assert.equal(parseWholeKes('921.00'),921);
  assert.equal(parseWholeKes('921.50'),null);
  assert.throws(() => calculateAmountDue(9.5,1));
});
test('Kenyan number parsing rejects arbitrary text',() => {
  assert.equal(normalizePhone('0712 345 678'),'+254712345678');
  assert.equal(normalizePhone('+254 (112) 345 678'),'+254112345678');
  assert.equal(normalizePhone('extension 0712345678'),'');
});
test('callback timestamp uses Nairobi time at midnight',() => {
  assert.equal(mpesaTimestamp(new Date('2026-11-09T21:00:00Z')),'20261110000000');
  assert.equal(parsePaymentCallback({}),null);
});
test('TOTP uses a standard test vector, and stored seeds authenticate',() => {
  const seed=Buffer.from('12345678901234567890');
  assert.equal(totpStep(seed,'287082',59000),1);
  const sealed=sealSeed('test key',seed);
  assert.deepEqual(openSeed('test key',sealed),seed);
  assert.throws(() => openSeed('different key',sealed));
  assert.equal(constantEqual(otpHash('key','id','123456'),otpHash('key','another','123456')),false);
});
test('checkout stays closed without explicit provider configuration',() => {
  const env={DATABASE_URL:'postgresql://airwaves@127.0.0.1/test',PUBLIC_ORIGIN:'https://example.test',SESSION_SECRET:'x'.repeat(40)};
  assert.equal(loadConfig(env).purchasesEnabled,false);
  assert.throws(() => loadConfig({...env,PURCHASES_ENABLED:'true',ENABLED_NETWORKS:'safaricom'}),/Missing configuration/);
  assert.throws(() => loadConfig({...env,DATABASE_URL:env.DATABASE_URL+'?sslmode=disable'}),/Configure TLS outside/);
});
