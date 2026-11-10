# Deployment guide

## 1. Upload source to GitHub

1. Extract the ZIP. Open a terminal in the extracted folder that contains `README.md`, `.env.example` and `compose.yaml`.
2. Create an empty **private** GitHub repository for AIRWAVES. Leave automatic README creation unchecked if you are starting a new repository.
3. Stage the code, inspect the list and push. Replace `OWNER/REPOSITORY` with your GitHub repository path.

```sh
git init -b main
git add .
git diff --cached --name-only
git commit -m "Add AIRWAVES airtime portal"
git remote add origin git@github.com:OWNER/REPOSITORY.git
git push -u origin main
```

4. Confirm `.env.example` appears in GitHub. The ignored files include `.env`, `secrets/`, database dumps and private keys. Use a protected branch and enable repository secret scanning or push protection where available. If a real secret was committed in an earlier repository, revoke and rotate it before using this release.

[GitHub import instructions](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)

## 2. Prepare the server and connect the domain

1. Provision a Linux VPS with Docker Engine and Docker Compose v2.30 or later. Install an SSH deploy key with read access to the private GitHub repository, then clone it onto the VPS.
2. Choose the canonical hostname, such as `airtime.example.com` or a hostname you control. For an existing customer domain, stage on a separate hostname before changing production DNS.
3. In DNS, add an `A` record pointing the hostname to the VPS IPv4 address. Add an `AAAA` record only when the VPS accepts public IPv6 traffic. For a subdomain you can also use a CNAME pointing to a valid host. Verify that DNS resolves to your VPS.
4. Open TCP 80 and 443 in the VPS firewall. Restrict SSH to administrators where practical. The bundled setup exposes only the Caddy proxy. The Node.js service and PostgreSQL communicate over the private Compose network.
5. Use the canonical HTTPS origin as `PUBLIC_ORIGIN`. The frontend and backend share it, which keeps session cookies and API calls on one domain. Caddy provisions and renews the certificate after DNS and firewall setup.

[Docker Compose in production](https://docs.docker.com/compose/how-tos/production/) · [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)

## 3. Store credentials and deploy

Run these steps on the VPS. Use a secret manager for the real provider credentials when the hosting platform supports server-side injection. For the included Compose deployment, keep the following files readable only by the deployment operator. Avoid pasting values into chat, tickets, screenshots, CI output or shell command arguments.

```sh
umask 077
mkdir -p secrets
cp .env.example .env
chmod 600 .env
openssl rand -hex 32 > secrets/postgres-admin-password
openssl rand -hex 32 > secrets/postgres-app-password
```

Edit `.env` using a private terminal. Put the contents of `secrets/postgres-app-password` into the password position of `DATABASE_URL`. Generate a separate `SESSION_SECRET` with `openssl rand -hex 32` and enter it through the editor. The bundled database uses an internal connection. For managed PostgreSQL use its TLS endpoint, set `DB_PRIVATE_NO_TLS=false` and configure the trusted CA through the host's Node trust configuration if required. Leave TLS options out of `DATABASE_URL`.

Keep `PURCHASES_ENABLED=false` and `PROVIDERS_ENABLED=false` for the first deployment. Set `SUPPORT_EMAIL` and the real HTTPS URLs for your purchase terms and privacy notice. The terms version identifies the customer terms recorded with each checkout. Use literal values in the Compose environment file. The Compose service uses raw env-file parsing, so quote marks in values are passed through.

```sh
docker compose up -d --build
docker compose ps
curl --fail https://airtime.example.com/api/v1/health
```

The database initialization script creates the dedicated application role on a new database volume. Do not regenerate the password files for an existing volume unless you also rotate the PostgreSQL role credentials. Keep the database and Caddy volumes persistent across deployments. Use encrypted database backups and test restores. The session secret also encrypts staff MFA seeds. Back it up in your secret manager separately from the database. Rotating it invalidates outstanding OTPs and requires re-provisioning staff MFA.

## 4. Set up staff access

Use Bash in a private VPS session. Provide a dedicated Kenyan staff phone number that has not been used for a customer account. Run the command for each staff member, using a unique username and password.

```bash
read -r -s -p "Staff password (16–128 characters): " AIRWAVES_ADMIN_PASSWORD; echo
printf '%s\n' "$AIRWAVES_ADMIN_PASSWORD" | docker compose exec -T app node src/admin.mjs STAFF_USERNAME STAFF_PHONE
unset AIRWAVES_ADMIN_PASSWORD
```

Enter a lowercase username in place of `STAFF_USERNAME` and the number in place of `STAFF_PHONE`. Enrol the displayed private key in a time-based authenticator with six digits and a 30-second period. Then open `https://airtime.example.com/admin/` and sign in with the password and current authenticator code. Run the same command with that username to rotate its password and MFA and revoke its existing sessions. Give staff access only to people who need the transaction register, payer and recipient numbers, and reconciliation records.

## 5. Configure callbacks and enable purchasing

1. Use a distinct PostgreSQL database, domain, callback tokens and provider credentials for staging. Run the provider checks in [INTEGRATIONS.md](INTEGRATIONS.md).
2. Enter a separate random 32-byte hex token for each webhook. The backend builds the URLs from `PUBLIC_ORIGIN` and passes them with each provider request.

| Service | Callback URL |
| --- | --- |
| M-Pesa Express | `https://airtime.example.com/api/v1/webhooks/mpesa/stk?token=<MPESA_CALLBACK_TOKEN>` |
| Banricom reseller | `https://airtime.example.com/api/v1/webhooks/airtime/banricom?token=<BANRICOM_CALLBACK_TOKEN>` |
| Banricom OTP SMS | No inbound callback is needed to send an OTP |

3. If a provider also requests registration or allowlisting, supply the exact applicable HTTPS callback URL through the provider's secure portal and confirm that it preserves the query string. If using an upstream WAF or proxy, allow provider POSTs to those exact paths, keep query strings out of logs and make sure the reverse proxy strips untrusted client forwarding headers. Never expose the Node port directly with proxy trust enabled.
4. For a controlled live test on each enabled network, set `PROVIDERS_ENABLED=true` and `PURCHASES_ENABLED=true`, then run `docker compose up -d --force-recreate app`. During the live pilot, use a restricted staging hostname or an edge access rule that allows designated testers and the callback routes. Open customer traffic only after the checks pass.
5. To pause new orders without disrupting callbacks and accepted live fulfilment jobs, set `PURCHASES_ENABLED=false`, leave `PROVIDERS_ENABLED=true` and recreate the app. Keep the existing provider credentials, callback tokens and enabled network settings while orders drain. Schedule callback token rotation outside an active checkout window or reconcile any outstanding references.

Callback tokens, provider credentials and the Etopup PIN belong in backend secrets. Keep them out of browser JavaScript and GitHub source, even in a private repository. If CI deploys the app, store the deploy key or deployment token in GitHub environment secrets. Inject application credentials at the host or from the hosting platform's runtime secret manager.

## Local development without provider access

Use Node.js 24+ and a local PostgreSQL database you control. Set `PUBLIC_ORIGIN=http://127.0.0.1:8787`, `LOCAL_HTTP=true`, `TRUST_CADDY_PROXY=false`, `DB_PRIVATE_NO_TLS=true` and your local `DATABASE_URL` in a private root `.env`. Keep both provider switches false. From `server/`, run `npm ci`, `npm test`, then `npm start`. You can register a real local account and test staff sign-in and the empty transaction register. For provider testing, use the HTTPS staging setup.
