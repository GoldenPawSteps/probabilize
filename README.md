# probabilize

Probabilize is an Express + SQLite web app.

## Run locally

1. Install dependencies:
	npm ci
2. Start the server:
	npm start
3. Open:
	http://localhost:3000

## Deploy on Render

This repo includes `render.yaml` for a Blueprint deploy.

1. Push this repository to GitHub.
2. In Render, click **New +** -> **Blueprint**.
3. Select this repository.
4. Render will detect `render.yaml` and create:
	- A Node web service
	- A persistent disk mounted at `/var/data`
5. Wait for the first deploy to finish.
6. Open `https://<your-service>.onrender.com`.

### Notes

- The app listens on `PORT` automatically.
- SQLite persistence is configured through `DB_PATH=/var/data/probabilize.db`.
- Health check endpoint: `/healthz`.

## Optional admin reset endpoint

You can enable an authenticated reset endpoint for fast DB wipes on Render.

1. Set an environment variable on Render:
	- `ADMIN_RESET_TOKEN=<long-random-secret>`
	- Optional: `ADMIN_RESET_IP_ALLOWLIST=<ip1>,<ip2>`
2. Redeploy the service.
3. Trigger reset:
	curl -X POST "https://<your-service>.onrender.com/admin/reset-db" \
	  -H "x-reset-token: <long-random-secret>"

Behavior:

- Disabled by default: if `ADMIN_RESET_TOKEN` is not set, endpoint returns 404.
- Enabled only with the correct token header.
- If `ADMIN_RESET_IP_ALLOWLIST` is set, only those source IPs can call the endpoint.
- Clears all app data (users, markets, portfolios, sessions, history) and resets market ID counter.

Check configuration before resetting:

curl "https://<your-service>.onrender.com/admin/reset-db/check"

Response includes:

- `resetEnabled`: whether `ADMIN_RESET_TOKEN` is configured.
- `ipAllowlistEnabled`: whether `ADMIN_RESET_IP_ALLOWLIST` is configured.
- `callerIp`: the server-observed caller IP.
- `callerIpAllowed`: whether that IP is currently allowed.

View reset audit entries (last 100):

curl "https://<your-service>.onrender.com/admin/reset-db/audit" \
	-H "x-reset-token: <long-random-secret>"

Audit details:

- Records each reset attempt outcome (`success`, `invalid-token`, `missing-token`, `ip-denied`, `disabled`).
- Stores timestamp, source IP, and user agent.
- Audit entries persist across DB resets (the reset operation does not clear `admin_audit`).

## Run demo seed on Render

From your Render service page, open Shell and run:

DB_PATH=/var/data/probabilize.db npm run seed:demo
DB_PATH=/var/data/probabilize.db npm run seed:check

If both commands succeed, restart the service so the app process picks up seeded data immediately.
