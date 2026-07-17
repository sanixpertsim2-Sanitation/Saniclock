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

## Implemented (2026-07-17) — iteration 3: full "Alabaster Authority" redesign
- COMPLETE visual pivot away from the dark neon/glass look to a premium light editorial
  system (design_agent direction, /app/design_guidelines.json updated).
  - Palette: alabaster #f7f7f5 / white surfaces / obsidian #090a0b text / electric blue
    #0044ff accent; crisp 1px borders; soft ambient shadows; NO neon/glass/particles.
  - Fonts: Cabinet Grotesk (bold display/headings/clock/KPIs) + Satoshi (body/UI) +
    JetBrains Mono (time/data). Loaded via Fontshare + Google.
  - Dashboard page(): already token-driven — retuned the light `:root`/[data-theme=light]
    tokens to Alabaster, forced default theme = light, swapped --serif/--sans/--mono,
    replaced the old neon/glass override blocks with a crisp "Alabaster Authority"
    override (bordered cards, blue active nav w/ left rail, mono clock).
  - Login: fully REWRITTEN — split screen (white form left / alabaster clock+shifts right),
    bold Cabinet Grotesk "Welcome back." + massive live clock, crisp shift segments
    (active = blue top border + ON NOW + progress), 256-bit trust cue, data-testids.
  - Employee portal /me: retuned to light Alabaster (tokens, fonts, sheets, status colors).
- Functionality unchanged (same element ids/logic; absence feature untouched).
- Verified: testing agent iteration 3 = 100% frontend pass, no UI bugs, no regressions,
  good contrast on all three surfaces. Applied a11y polish (shift badge aria-hidden).

## Implemented (2026-07-17) — iteration 2
- Login rebrand: wordmark "SaniClock · Powered by SaniXperts", "Introducing SaniClock"
  pill, removed "entire Ferrero floor" copy (now "your entire workforce … Powered by
  SaniXperts"), kept bottom-right "Ferrero · Attendance & Payroll" (temporary).
- Login shift section redesigned: three premium glass shift cards (Day/Afternoon/Night)
  with sun/sunset/moon icons, per-shift accent color, animated live progress bar +
  "Xh Ym elapsed · Zh left" meta, "ON NOW" glow on the active card.
- Extra login motion: rising ember particles, rotating conic glow ring behind the logo,
  mouse parallax on aurora + flame watermark, animated gradient text sweep.
- FUNCTIONAL Absence / Leave feature (replaced the "coming soon" placeholder):
  - Backend: data/absence-requests.json store; GET/POST /api/my-absence-requests
    (employee, esid-gated), GET /api/absence-requests, POST .../approve|reject,
    DELETE /api/absence-requests (admin). /api/my-absence-requests added to PUBLIC_ROUTES.
  - Admin dashboard: "Absence Requests" nav (pending count badge) + absenceView with
    segbar (Pending/Approved/Rejected/All) and Approve/Reject/Delete actions.
  - Employee portal /me: "Request absence or leave" button opens a sheet (type, start/end
    date, reason) → submits for approval; shows the employee's own requests with status.
- Verified: testing agent iteration 2 = 100% frontend pass; backend endpoints verified
  via curl (admin list/approve ok; employee POST 401 without session).

## Next / backlog (P1/P2)
- P1: Restyle `MOBILE_HTML` (`/m` admin PWA) to match the premium system.
- P2: Fold approved leave into payroll/attendance reporting (currently recorded only).
- P2: Email notification to employee on approve/reject (nodemailer already wired).
- P2: Replace circular badge with a clean flame-only mark (transparent) for crisper
  small sizes; consider a custom favicon/PWA icon refresh in brand blue.
- P2: Seed demo employee data so `/me` portal and dashboard charts can be previewed.
- P2: Charts (recharts-style) already hand-drawn SVG — add subtle entrance animation.
