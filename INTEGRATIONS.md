# Provider setup and acceptance tests

The provider request formats were compared with the supplied AIRWAVES v80 and PrimeKredo code. Use the current contracts from your actual accounts to confirm credentials, acceptance codes, service permissions, settlement, delivery semantics and callback format before opening purchases.

## M-Pesa Daraja STK Push and callbacks

**Purpose** — Request M-Pesa payment and confirm the result before airtime is sent. OAuth uses the Daraja consumer key and secret. M-Pesa Express uses the shortcode, passkey, transaction type and receiving PartyB.

1. Sign in to Safaricom Daraja. Create a staging app with the M-Pesa Express product and obtain its test credentials, shortcode and passkey. Confirm STK status queries are available.
2. Set `MPESA_ENVIRONMENT=sandbox`, the `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_PARTY_B` and a unique `MPESA_CALLBACK_TOKEN`. Use `CustomerPayBillOnline` for an approved Paybill and `CustomerBuyGoodsOnline` for an approved Buy Goods configuration. Confirm the exact shortcode and PartyB values with Safaricom.
3. With the SMS provider configured on the HTTPS staging site, open a checkout on a permitted tester account. Verify that the request is accepted and the public callback reaches the endpoint in the deployment guide. A success callback must match the payer, amount and merchant reference. Confirm the status query returns the same checkout and merchant IDs and result code zero. A sandbox payment cannot trigger real airtime or a purchase receipt.
4. Test cancellation, timeout, mismatched amount, an incorrect callback token and delivery of the same callback more than once. Check that no invalid or duplicate callback initiates airtime.
5. Apply for Go Live in Daraja with the business's approved shortcode and the organization's M-Pesa account details. When approved, use the issued production credentials, a distinct production callback token and `MPESA_ENVIRONMENT=live`. Confirm the exact Paybill or Till routing with Safaricom and complete a controlled low-value payment before broad access.

A successful status query alone does not supply the callback receipt metadata required by this application. If the callback is missing, use the staff portal to query Daraja and record the reconciliation result against the order. Investigate the M-Pesa statement and provider record before retrying or resolving the case outside the app. Only an authenticated successful callback paired with a matching successful query advances automated fulfilment.

[Safaricom Daraja](https://developer.safaricom.co.ke/) · [M-Pesa Express product](https://developer.safaricom.co.ke/apis/MpesaExpressSimulate)

## SMS Sender ID via Banricom

**Purpose** — Send a six-digit, five-minute verification code to the M-Pesa payer. The API uses Banricom's app ID and API key headers, with the approved Sender ID or shortcode and recipient in the body. A provider submission acceptance and an actual SMS arriving on a handset are separate checks.

1. Request a Banricom SMS API account and apply for an approved branded Sender ID or assigned shortcode. Obtain the permitted URL, app ID, API key, exact sender value and test credit or sandbox access.
2. Set `BANRICOM_SMS_URL`, `BANRICOM_SMS_APP_ID`, `BANRICOM_SMS_API_KEY` and `BANRICOM_SMS_SHORTCODE`. Ask Banricom for the JSON field and value that confirm the provider accepted a message. Set `BANRICOM_SMS_ACCEPTANCE_PATH` to that field path and `BANRICOM_SMS_ACCEPTANCE_VALUE` to the exact scalar value. A dotted path denotes nested JSON fields. Leave purchases closed until these are confirmed.
3. On staging, verify the approved sender appears on a permitted handset and that the correct OTP starts one STK request. Check that a wrong or expired code cannot initiate STK and a replay never sends a second prompt. Verify that API rejection leaves the order without an active OTP. When performing lockout tests use a dedicated staging account.
4. Verify delivery using the provider dashboard and the actual handset. The application only stores a keyed digest of the code and does not expose OTP values in its API responses.

## Safaricom Etopup / PreTUPS

**Purpose** — Deliver Safaricom airtime from an authorized dealer or Etopup account after confirmed live M-Pesa payment.

1. Contact your Safaricom airtime dealer or enterprise integration representative. Request approval for the PreTUPS recharge product, its OAuth consumer credentials, authorized sender MSISDN, service PIN, minimum and maximum values, wallet funding, IP allowlisting if applicable, test environment details and transaction reconciliation access.
2. Set `SAFARICOM_CONSUMER_KEY`, `SAFARICOM_CONSUMER_SECRET`, `SAFARICOM_SENDER`, `SAFARICOM_SERVICE_PIN` and the documented `SAFARICOM_ACCEPTANCE_VALUE`. Confirm the endpoint and payload with the provider. The existing adapter follows the supplied source's recharge endpoint and sends amounts in hundredths of a shilling and the receiver as the final nine digits.
3. Obtain written confirmation that the configured `responseStatus` together with `transId` means final delivery. If the provider confirms only acceptance, the adapter needs that provider's final status API or authenticated callback before you enable Safaricom checkout.
4. After approval, enable only `safaricom` in an isolated live pilot. Buy the lowest approved value for a permitted test recipient and compare the recipient's balance, provider transaction ID, M-Pesa record and customer receipt. Test a declined or ambiguous provider response and confirm it remains in review with no automatic retry.

The adapter targets the production recharge URL from the supplied code and has no Etopup sandbox mode. Use provider-supplied tools to test an Etopup sandbox if one is issued. The Daraja sandbox is isolated from real airtime dispatch.

## Banricom reseller airtime

**Purpose** — Optional airtime route for approved Airtel, Telkom and JTL/Faiba numbers. Submission and final delivery are handled separately.

1. Request a Banricom reseller API account with airtime wallet access, token authorization and a passkey. Confirm the exact supported networks, number format, funded balance, approval requirements, acceptance status, webhook fields and terminal status values. In particular, obtain explicit JTL/Faiba coverage confirmation before enabling that network.
2. Set `BANRICOM_AUTHORIZATION` to the complete provider Authorization header value, `BANRICOM_PASSKEY`, the documented `BANRICOM_ACCEPTANCE_VALUE`, and a unique `BANRICOM_CALLBACK_TOKEN`. Set the documented `BANRICOM_DELIVERED_STATUS_VALUES` and `BANRICOM_FAILED_STATUS_VALUES` as comma-separated, non-overlapping lists.
3. Confirm that the provider sends a POST with `requestId` and `status` in JSON, URL-encoded form or the agreed query fields and preserves the secret query token. If your Banricom contract differs, adapt the endpoint and test the actual callback before enabling the affected networks.
4. Pilot one network at a time. Confirm that a submission returns a request ID, the transaction stays in progress until the final callback and the receipt becomes available only after delivery. Compare the result with the provider dashboard and recipient handset. A late matching terminal callback can resolve an uncertain delivery.
5. Confirm the actual recipient network before sending airtime. The customer explicitly selects it. Keep only networks you have verified in `ENABLED_NETWORKS`.

## Before opening customer traffic

Verify an actual paid top-up and receipt on each enabled network. Check monitoring for callback lag, records needing review and provider balance. Run an interrupted delivery test with the provider and document how staff locate the original request before any manual retry. Keep checkout disabled if a provider cannot confirm the request or callback contract.
