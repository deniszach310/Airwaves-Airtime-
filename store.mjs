import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

export function database(config) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl, ssl: config.dbTls ? { rejectUnauthorized: true } : false,
    max: 12, connectionTimeoutMillis: 5000,
  });
  pool.on('error', () => console.error('Idle database connection failed.'));
  return pool;
}

const hash = text => createHash('sha256').update(text).digest('hex');
const transactionFilter = `($1::uuid IS NULL OR user_id=$1)
  AND ($2='' OR payment_status=$2 OR fulfillment_status=$2)
  AND ($3::date IS NULL OR created_at>=($3::date::timestamp AT TIME ZONE 'Africa/Nairobi'))
  AND ($4::date IS NULL OR created_at<(($4::date+1)::timestamp AT TIME ZONE 'Africa/Nairobi'))
  AND ($5::integer IS NULL OR airtime_amount=$5)
  AND (verified_at IS NOT NULL OR failed_attempts>=3 OR created_at>=now()-interval '5 minutes')`;

export class PostgresStore {
  constructor(pool) { this.pool = pool; }
  query(sql, args) { return this.pool.query(sql, args); }
  async first(sql, args) { return (await this.query(sql,args)).rows[0]; }
  async migrate() {
    const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
    await this.query('BEGIN; SELECT pg_advisory_xact_lock(642271); ' + schema + ' COMMIT;');
  }
  async rate(bucket, max, seconds) {
    const row = await this.first(`INSERT INTO api_rate_limits(bucket,hits,expires_at)
      VALUES($1,1,now()+$2*interval '1 second') ON CONFLICT(bucket) DO UPDATE SET
      hits=CASE WHEN api_rate_limits.expires_at <= now() THEN 1 ELSE api_rate_limits.hits+1 END,
      expires_at=CASE WHEN api_rate_limits.expires_at <= now() THEN EXCLUDED.expires_at ELSE api_rate_limits.expires_at END
      RETURNING hits`, [hash(bucket),seconds]);
    return row.hits <= max;
  }
  register(name, phone, email, password) {
    return this.first('INSERT INTO api_users(full_name,phone_e164,email,password_hash) VALUES($1,$2,$3,$4) RETURNING *', [name,phone,email,password]);
  }
  customer(identifier) {
    return this.first('SELECT * FROM api_users WHERE admin_username IS NULL AND (phone_e164=$1 OR lower(email)=$1) LIMIT 1',[identifier]);
  }
  admin(username) {
    return this.first('SELECT * FROM api_users WHERE admin_username=$1',[username]);
  }
  provisionAdmin(username, phone, password, seed) {
    return this.first(`WITH saved AS (
      INSERT INTO api_users(full_name,phone_e164,password_hash,admin_username,admin_totp)
      VALUES($1,$2,$3,$1,$4)
      ON CONFLICT(admin_username) DO UPDATE SET phone_e164=EXCLUDED.phone_e164, password_hash=EXCLUDED.password_hash,
      admin_totp=EXCLUDED.admin_totp,admin_last_step=-1,account_status='active' RETURNING id
    ), revoked AS (
      UPDATE api_sessions SET revoked_at=now() WHERE user_id=(SELECT id FROM saved)
    ) SELECT id FROM saved`,[username,phone,password,seed]);
  }
  async claimAdminStep(id, step, passwordHash, totp) {
    return !!await this.first(`UPDATE api_users SET admin_last_step=$2 WHERE id=$1 AND admin_last_step<$2 AND account_status='active'
      AND password_hash=$3 AND admin_totp=$4 RETURNING id`,[id,step,passwordHash,totp]);
  }
  sessionCreate(id, token, admin, seconds) {
    return this.query(`INSERT INTO api_sessions(token_hash,user_id,expires_at,is_admin)
      VALUES($1,$2,now()+$3*interval '1 second',$4)`,[hash(token),id,seconds,admin]);
  }
  session(token, admin) {
    return this.first(`SELECT u.id,u.full_name,u.phone_e164,u.email,u.admin_username FROM api_sessions s JOIN api_users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL AND s.is_admin=$2
      AND u.account_status='active' AND (u.admin_username IS NOT NULL)=$2`,[hash(token),admin]);
  }
  revoke(token) { return this.query('UPDATE api_sessions SET revoked_at=now() WHERE token_hash=$1',[hash(token)]); }
  createCheckout(c) {
    return this.first(`INSERT INTO api_checkouts(id,user_id,payer_e164,recipient_e164,network,airtime_amount,discount_percent,
      amount_due,terms_version,otp_hash,otp_expires_at,payment_environment)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+interval '5 minutes',$11) RETURNING *`,
      [c.id,c.userId,c.payer,c.recipient,c.network,c.amount,c.discount,c.due,c.termsVersion,c.otpHash,c.environment]);
  }
  otpSent(id) { return this.query('UPDATE api_checkouts SET otp_sent_at=now(),updated_at=now() WHERE id=$1',[id]); }
  async verifyOtp(id, user, digest, environment) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(`SELECT c.* FROM api_checkouts c JOIN api_users u ON u.id=c.user_id
        WHERE c.id=$1 AND c.user_id=$2 AND c.payment_environment=$3 AND c.otp_sent_at IS NOT NULL
        AND c.payment_status='otp_pending' AND c.otp_expires_at>now() AND u.account_status='active' FOR UPDATE OF c,u`,[id,user,environment])).rows[0];
      if (!row) { await client.query('ROLLBACK'); return null; }
      const correct = digest(row.otp_hash);
      if (correct) {
        await client.query(`UPDATE api_checkouts SET payment_status='stk_dispatching', verified_at=now(),otp_hash='',updated_at=now() WHERE id=$1`,[id]);
      } else {
        row.failed_attempts++;
        const locked = row.failed_attempts >= 3;
        await client.query(`UPDATE api_checkouts SET failed_attempts=$2, payment_status=CASE WHEN $3 THEN 'failed' ELSE payment_status END,
          failure_code=CASE WHEN $3 THEN 'OTP_ATTEMPTS_EXCEEDED' ELSE NULL END, updated_at=now() WHERE id=$1`,[id,row.failed_attempts,locked]);
        if (locked) await client.query("UPDATE api_users SET account_status='restricted' WHERE id=$1",[user]);
      }
      await client.query('COMMIT');
      return { correct, row };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  stkAccepted(id, checkout, merchant) {
    return this.query(`UPDATE api_checkouts SET checkout_request_id=$2,merchant_request_id=$3,payment_status='pending',updated_at=now()
      WHERE id=$1 AND payment_status IN ('stk_dispatching','uncertain')`,[id,checkout,merchant]);
  }
  paymentError(id, expected, status, code) {
    return this.query(`UPDATE api_checkouts SET payment_status=$3,failure_code=$4,updated_at=now() WHERE id=$1 AND payment_status=ANY($2::text[])`,[id,[expected].flat(),status,code]);
  }
  transaction(id, user = null) {
    return this.first(`SELECT c.*,u.account_status FROM api_checkouts c JOIN api_users u ON u.id=c.user_id
      WHERE c.id=$1 AND ($2::uuid IS NULL OR c.user_id=$2)`,[id,user]);
  }
  async transactions(user, filter) {
    const params = [user,filter.status,filter.from||null,filter.to||null,filter.amount||null];
    const { rows } = await this.query(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created
      FROM api_checkouts WHERE ${transactionFilter} AND ($6::timestamptz IS NULL OR (created_at,id)<($6,$7::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 51`,[...params,filter.before?.created ?? null,filter.before?.id ?? null]);
    const summary = user === null ? await this.first(`SELECT count(*) AS matches,
      COALESCE(sum(airtime_amount),0) AS matched_airtime,
      COALESCE(sum(airtime_amount) FILTER (WHERE fulfillment_status='delivered' AND payment_environment IS DISTINCT FROM 'sandbox'),0) AS delivered_airtime
      FROM api_checkouts WHERE ${transactionFilter}`,params) : undefined;
    return { rows,summary };
  }
  async releaseRestriction(checkoutId,adminId,reason) {
    return !!await this.first(`WITH released AS (
      UPDATE api_users u SET account_status='active' FROM api_checkouts c
      WHERE c.id=$1 AND c.user_id=u.id AND u.admin_username IS NULL
        AND u.account_status='restricted' AND c.failure_code='OTP_ATTEMPTS_EXCEEDED'
      RETURNING u.id
    ), revoked AS (
      UPDATE api_sessions SET revoked_at=now() WHERE user_id=(SELECT id FROM released)
    )
    INSERT INTO api_admin_audit(admin_id,checkout_id,action,detail)
      SELECT $2,$1,'account_unlocked',$3 FROM released RETURNING id`,[checkoutId,adminId,reason]);
  }
  byRequest(id, environment) {
    return this.first('SELECT * FROM api_checkouts WHERE checkout_request_id=$1 AND payment_environment=$2',[id,environment]);
  }
  byProvider(id) {
    return this.first("SELECT * FROM api_checkouts WHERE provider_request_id=$1 AND network<>'safaricom' AND payment_environment='live'",[id]);
  }
  enqueue(kind, ref, key, payload, environment) {
    return this.query(`INSERT INTO api_provider_events(kind,provider_ref,event_key,payload,environment)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[kind,ref,key,payload,environment]);
  }
  async events(environment) {
    return (await this.query(`SELECT * FROM api_provider_events WHERE handled_at IS NULL AND next_attempt<=now()
      AND environment=$1 ORDER BY next_attempt LIMIT 8`,[environment])).rows;
  }
  recordEvent(event, outcome) {
    return this.query(`UPDATE api_provider_events SET handled_at=CASE WHEN $5::text IS NULL THEN NULL ELSE now() END,
      outcome=$5,next_attempt=now()+interval '30 seconds'
      WHERE kind=$1 AND provider_ref=$2 AND event_key=$3 AND environment=$4 AND handled_at IS NULL`,
      [event.kind,event.provider_ref,event.event_key,event.environment,outcome]);
  }
  async confirmPayment(id, receipt) {
    try {
      return !!await this.first(`UPDATE api_checkouts SET payment_status='paid',mpesa_receipt=$2,paid_at=now(),failure_code=NULL,updated_at=now()
        WHERE id=$1 AND payment_status IN ('pending','failed','uncertain') AND checkout_request_id IS NOT NULL RETURNING id`,[id,receipt]);
    } catch (error) {
      if (error.code === '23505') return false;
      throw error;
    }
  }
  claimDelivery() {
    return this.first(`WITH next AS (SELECT id FROM api_checkouts WHERE payment_status='paid' AND fulfillment_status='not_started'
      AND payment_environment='live' ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE api_checkouts c SET fulfillment_status='processing',updated_at=now() FROM next
      WHERE c.id=next.id RETURNING c.*`);
  }
  delivery(id, status, ref, code) {
    return this.query(`UPDATE api_checkouts SET fulfillment_status=$2,provider_request_id=COALESCE($3,provider_request_id),
      failure_code=$4,updated_at=now(),delivered_at=CASE WHEN $2='delivered' THEN now() ELSE delivered_at END
      WHERE id=$1 AND fulfillment_status IN ('processing','uncertain')`,[id,status,ref,code]);
  }
  audit(admin, id, action, detail) {
    return this.query('INSERT INTO api_admin_audit(admin_id,checkout_id,action,detail) VALUES($1,$2,$3,$4)',[admin,id,action,detail]);
  }
  async auditHistory(id) {
    return (await this.query('SELECT a.action,a.detail,a.created_at,u.admin_username FROM api_admin_audit a JOIN api_users u ON a.admin_id=u.id WHERE a.checkout_id=$1 ORDER BY a.id DESC LIMIT 25',[id])).rows;
  }
  async maintain() {
    await this.query(`UPDATE api_checkouts SET payment_status='uncertain',failure_code='PAYMENT_REVIEW_REQUIRED',updated_at=now()
      WHERE (payment_status='stk_dispatching' AND updated_at<now()-interval '2 minutes')
         OR (payment_status='pending' AND updated_at<now()-interval '15 minutes')`);
    await this.query(`UPDATE api_checkouts SET fulfillment_status='uncertain',failure_code='DELIVERY_REVIEW_REQUIRED',updated_at=now()
      WHERE fulfillment_status='processing' AND updated_at<now()-interval '15 minutes'`);
    await this.query("DELETE FROM api_rate_limits WHERE expires_at<now()-interval '1 hour'");
    await this.query("DELETE FROM api_sessions WHERE expires_at<now()-interval '7 days'");
    await this.query("DELETE FROM api_provider_events WHERE created_at<now()-interval '30 days'");
  }
}
