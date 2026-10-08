# PickleUP! v8.26.1 audit

Scope: `netlify/functions/api.mjs`, `public/` (app, 2 static pages, service worker, manifest), `netlify.toml`, tests.

## Verified
- 71 non-UI tests pass (`core`, `rating`, `social`, `cover`, `clubs`, `audit`, `google`, chat, weekly).
- `api.mjs` passes `node --check`; no stray `console.log`.
- Auth: scrypt hashing, HMAC tokens, lockouts, reserved usernames, no default admin password.
- Signing secret: uses `SESSION_SECRET`, else a random one stored once in Blobs (race-safe).
- Security headers, CSP (report-only), `/api/*` noindex, robots and sitemap present.
- Service worker: network-first pages, stale-while-revalidate assets, `/api` never cached.

## Changed in this release
- `netlify.toml`: PNG icons and OG image now cached (same policy as webp).
- `package.json`: name `the-system` -> `pickleup` (Blobs store name unchanged on purpose, so existing data is kept).
- `AUDIT.md`: replaced the stale v7.2 text.

## Not done / your action
1. **Set `SESSION_SECRET` and `ADMIN_PASSWORD`** in Netlify > Site settings > Environment variables, then redeploy. Without `ADMIN_PASSWORD` there is no admin.
2. **Add `google82857a2dad063ae9.html`** to `public/` (re-download from Search Console). It was not in the upload.
3. **CSP**: after a week with no console warnings, rename `Content-Security-Policy-Report-Only` to `Content-Security-Policy`.
4. **Custom domain**: replace `pickleup.netlify.app` in `index.html`, the 2 static pages, `robots.txt`, `sitemap.xml`.
5. **UI tests** (`ui.test.mjs`) need jsdom and were not run here: run `npm install && npm test` once.
6. In Admin, set Facility time zone to `Asia/Manila` if it was saved as `UTC`.
7. `README.md` is a long product description from an older repo; trim or rewrite when convenient.

## Known limits
- `public/index.html` is ~200 KB in one file (inline JS/CSS). Fine for now; gzip on Netlify cuts it substantially. Splitting it is the next optimization, but risky without UI tests.
- No live-deploy or real-device testing was done.
