# AIRWAVES Airtime Portal

The application serves the AIRWAVES storefront and customer account at `/`, a separate staff sign-in at `/admin/`, and the JSON API under `/api/v1/`. Node.js serves the frontend and backend from the same HTTPS origin. PostgreSQL stores accounts, sessions, orders, callback events and reconciliation notes.

Purchases start disabled. With approved provider settings, the purchase flow issues an exact quote, sends an SMS OTP to the M-Pesa payer, consumes the OTP once and initiates STK Push. The backend validates the payment callback and independently checks the successful STK result with Daraja. Live payments then enter the airtime queue. After confirmed delivery, the customer can open and print the AIRWAVES receipt. The amount due is calculated on the server and rounded up to the nearest whole shilling.

- [Deployment, DNS, secrets and GitHub](docs/DEPLOYMENT.md)
- [Provider access, configuration and acceptance tests](docs/INTEGRATIONS.md)
- [Verification results, operational boundaries and upgrade notes](docs/VERIFICATION.md)

## Source layout

| Path | Contents |
| --- | --- |
| `dist/` | Public homepage, customer account and staff screens |
| `server/src/` | HTTP routes, authentication, payment and airtime adapters, background processing and admin provisioning |
| `server/schema.sql` | PostgreSQL schema and additive migrations |
| `.env.example` | Server configuration template |
| `compose.yaml` and `deploy/` | HTTPS proxy, backend and private PostgreSQL deployment |
| `server/test/` | Unit checks |

Run `npm ci` then `npm test` from `server/` with Node.js 24 or later. The deployment guide covers starting the service and provisioning the first staff account.
