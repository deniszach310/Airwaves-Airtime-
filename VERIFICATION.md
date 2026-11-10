# Verification and release boundaries

Verification date is 10 November 2026. The starting archive was AIRWAVES v80. Provider requests were reviewed against the PrimeKredo integration source as well. The release keeps the existing PostgreSQL table names and the base pricing and provider conventions. It replaces the browser prototype with server-backed workflows.

## Test results

| Component | Verified locally | Remaining verification |
| --- | --- | --- |
| Public site and customer account | Chromium mobile check, registration, signed-in session persistence, availability and empty history. API check for transaction ownership and exact quotes. Chromium opened the delivered order receipt and checked its print layout. | Hosted HTTPS, domain and a customer pilot. |
| Staff portal | Chromium staff sign-in, TOTP, register filters and logout. API and PostgreSQL checks for separate customer and staff sessions, one-time TOTP, date and amount totals, reconciliation notes, and unlocking a restricted account with a reason. | Provision named staff accounts on the target server. |
| M-Pesa Daraja STK Push and callbacks | OAuth and STK payloads, one STK for simultaneous OTP verification attempts, callback token, amount and reference checks, duplicate handling, status query and payment state. | Sandbox OAuth and callback delivery, production Paybill or Till approval and actual payment confirmation. |
| Banricom SMS Sender ID | App ID and API key headers, message payload, configured acceptance response, OTP ownership, expiration logic and failed-attempt restriction. | Real credentials, approved Sender ID, confirmed response contract and SMS delivery on a handset. |
| Safaricom Etopup / PreTUPS | OAuth and recharge payload, response classification, provider reference, persisted delivery and receipt, and an ambiguous response entering review without an automatic resend. Daraja sandbox blocked Etopup. | Dealer provisioning, funded account, exact provider success contract and live recipient credit. |
| Banricom reseller airtime | Auth and submission, processing status, early callback persistence and final delivery on a matching terminal callback. | Reseller approval, credentials, supported networks, exact callback contract and live recipient credit. |
| Deployment package | Source syntax, dependency installation, unit checks and local app startup against PostgreSQL. | Docker Compose stack, public DNS, certificates and inbound callbacks on the deployment host. |

The local integration run used PostgreSQL 18 and the application’s actual HTTP routes and state transitions. The four provider boundaries used controlled test responses outside the release package. Actual provider SMS messages, charges, top-ups and production callbacks require the acceptance tests in [INTEGRATIONS.md](INTEGRATIONS.md).

## Upgrade from an existing AIRWAVES database

1. Back up PostgreSQL. Restore into a staging copy and run the new server against that copy first.
2. The migration adds fields for staff access, OTP submission, payment environment, delivery timestamps, callback processing and audit history. Existing orders remain available for review according to the register filters.
3. Prior orders with an unspecified payment environment are displayed as prior-release records. Their unresolved payments or deliveries require reconciliation before cutover. A new worker processes only orders tagged for its environment, so it will not automatically redispatch earlier records.
4. Stop or drain the earlier worker before switching callbacks and DNS. Keep the staged and production databases separate.

## Operations included in this release

- Public homepage with configured availability and pricing limits.
- Customer registration, sign-in, quote, OTP, M-Pesa checkout, history and printable receipts.
- A separate staff portal with a filterable transaction register, matched and delivered airtime totals, Daraja query, reconciliation notes, and audited release of OTP restrictions.
- PostgreSQL persistence and safe review states for uncertain payment or delivery. Pending callback events retry for up to 24 hours when correlation or query confirmation is unavailable. An in-flight airtime request that cannot be confirmed requires provider reconciliation. Staff should look up the original transaction before taking any manual action.

The register uses one staff permission level. Separate support roles, self-service password reset, helpdesk chat, automated finance dashboards, provider balance monitoring, manual or bulk airtime and homepage media editing still require implementation. Checkout abuse controls in this release use database-backed limits by account, payer and IP. The Turnstile widget from the earlier prototype is outside this release.
