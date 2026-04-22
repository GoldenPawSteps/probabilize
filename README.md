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
