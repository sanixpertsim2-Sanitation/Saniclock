# SaniClock

Self-hosted time & attendance and payroll workspace for the Ferrero facility, built by **SaniXperts**. SaniClock is the single control panel — employee management, fingerprint enrollment, live attendance, timecard correction, and automatic payroll — with NGTeco used only as a backend device bridge.

## Stack
- Node.js (zero-framework `http` server), no build step
- `nodemailer` for employee email invites (only runtime dependency)
- PWA front-ends: admin app (`/m`) and employee self-service portal (`/me`)

## Layout
| Path | Purpose |
|------|---------|
| `scale.js` | Main dashboard server — routes, dashboard UI, login, admin/employee PWAs, NGTeco bridge, email invites |
| `lib/time-engine.js` | Pay engine — shift classification, break auto-detection, no-overtime rollup |
| `lib/ngteco-api.js` | NGTeco cloud client — employee CRUD, fingerprint remote-enroll, scoped-token auth |
| `lib/emp-auth.js` | Per-employee self-service credentials (scrypt) + sessions |
| `lib/mailer.js` | SMTP wrapper (config read from `.mail.env`, root-only) |
| `ngteco-pull-auto.js` | Scheduled punch pull from NGTeco into SaniClock |
| `iclock-receiver.js` | Device push receiver (ADMS/iclock protocol experiments) |
| `kit/` | NGTeco/BEST-W intercept toolkit (reverse-engineering utilities) |
| `saniclock-site/` | Static marketing/landing page |
| `paysheet-rules.json` | Pay period + shift rule configuration |

## Not in this repo (by design)
Secrets and runtime state are intentionally excluded via `.gitignore`:
- `.mail.env`, `.ngteco.env` — SMTP + NGTeco API credentials
- `data/` — employee records, scrypt-hashed logins, admin credential, attendance CSVs (only static PWA icons and the login background are tracked)
- `node_modules/`, timestamped `*.bak-*` backups

## Run
```bash
npm install
SANICLOCK_PASS=... node scale.js   # served behind a reverse proxy on the VPS
```
Runtime data lives in `data/` (created on first run); populate `.mail.env` and `.ngteco.env` before enabling email invites and the NGTeco bridge.
