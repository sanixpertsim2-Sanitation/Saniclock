# SaniClock — Premium UI/UX Redesign (PRD)

## Original problem statement
Existing site (https://saniclock.anubhavflow.com/) — SaniXperts attendance clock-in
system. Make the UI/UX premium, gorgeous, high-quality/luxury with beautiful motion
design. UI/UX + animations only (no data/backend logic changes). Add an "absence /
leave request" feature shown as a faded "Coming soon".

## Stack / architecture (existing, unchanged)
- Single-file Node.js zero-dependency HTTP server: `scale.js` (~3.5k lines).
- All UI is server-rendered HTML/CSS/JS embedded as string templates inside scale.js:
  - `LOGIN_HTML`  → admin sign-in split screen (`/login`)  ← fully redesigned
  - `page()`      → admin command center dashboard (`/`)   ← premium layer added
  - `ME_HTML`     → employee self-service portal (`/me`)    ← premium + absence card
  - `MOBILE_HTML` → admin PWA (`/m`)                        ← not yet restyled
- Supporting libs in `lib/` (time-engine, payroll, emp-auth, ngteco, etc.) untouched.
- Brand: electric-blue flame droplet + chrome "SANIXPERTS" wordmark (logos in data/).

## Design system (this redesign)
- Concept: "Industrial precision × electric-blue luxury" on deep obsidian/navy.
- Fonts: `Fraunces` (serif display: headlines, wordmark, live clock) + `Outfit`
  (geometric sans: body, data, UI). Loaded via Google Fonts CDN.
- Accent: SaniXperts blue (#2f7bff / #59a6ff), chrome, emerald live pips.
- Motion: drifting aurora, animated live clock, staggered reveals, shimmer button,
  logo breathe glow, nav accent bar, card hover glows. Respects prefers-reduced-motion.
- Guidelines file: `/app/design_guidelines.json`.

## Implemented (2026-07-17)
- Premium `/login` redesign: aurora bg, grain/grid, serif clock+headline, animated
  shift ribbon, glass sign-in card w/ shimmer CTA, real logo, "Absence & leave — Soon"
  teaser. Login flow verified (admin/Saniclock2026!).
- Admin dashboard `/`: Fraunces+Outfit typography app-wide, real logo badge (breathe
  glow), premium active-nav accent bar + gradient, ambient bg glow, staggered KPI/panel
  entrance, glass header. Added faded "Request Absence — SOON" nav item.
- Employee portal `/me`: premium fonts, real logo, and a faded "Request absence & leave
  — Coming soon" card added under the punch-correction button.
- Added `/brand-badge.png`, `/brand-flame.png`, `/brand-white.png` routes + optimized
  assets in data/ (whitelisted in .gitignore). Added `run-preview.sh`.

## Next / backlog (P1/P2)
- P1: Restyle `MOBILE_HTML` (`/m` admin PWA) to match the premium system.
- P1: Wire the "Request Absence / Leave" feature for real (form → approval queue,
  reuse the mend-punch approval pattern) when the user is ready to ship it.
- P2: Replace circular badge with a clean flame-only mark (transparent) for crisper
  small sizes; consider a custom favicon/PWA icon refresh in brand blue.
- P2: Seed demo employee data so `/me` portal and dashboard charts can be previewed.
- P2: Charts (recharts-style) already hand-drawn SVG — add subtle entrance animation.
