# SaniClock — Test Credentials (preview environment)

## Admin (command center at `/` and login at `/login`)
- Username: `admin`
- Password: `Saniclock2026!`

> Set via supervisor env for the preview (SANICLOCK_USER / SANICLOCK_PASS).
> In production this is configured on the VPS via the `SANICLOCK_PASS` env var
> (first-run seeds an scrypt-hashed admin credential into `data/`).

## Employee self-service portal (`/me`)
- Requires per-employee accounts created by the admin (email + emailed password).
- No seeded employee accounts exist in the preview (data/ is gitignored / empty),
  so the `/me` login screen renders but cannot authenticate without real data.

## Preview runtime note
The app is a single-file Node server (`scale.js`). In this React/FastAPI-oriented
environment it is run under supervisor on BOTH ports so the ingress works:
- `saniclock_web`  → PORT 3000 (serves HTML pages: /login, /, /me, /m)
- `saniclock_api`  → PORT 8001 (serves /api/* so the /api ingress route resolves)
Both share SANICLOCK_SECRET so sessions validate. Restart: `bash /app/run-preview.sh`
(or `sudo supervisorctl restart saniclock_web saniclock_api`).
