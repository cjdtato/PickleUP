# PickleUP! v8.32.3 audit status

Checked by code reading and the test suite (84 of 85 pass; `ui.test.mjs` needs `npm install` for jsdom). Not tested on real phones or a live deploy.

## Fixed and confirmed in the code
- Login lockout per username + IP, plus a per-username cap; admin reset clears it.
- Password minimum 8 for new and changed passwords (old 6-character passwords can still log in).
- Image uploads (profile, cover, chat) must match the claimed JPEG/PNG/WebP bytes.
- Open play ranked games: both teams must confirm a score; repeat-group damping applies; flags show in the admin panel.
- `.gitignore` named correctly; no stray root `sw.js` or placeholder files.
- Service worker cache is capped at 120 entries (new in v8.32.3).
- HSTS, Permissions-Policy and CSP (Report-Only) set in `netlify.toml`.

## Open
1. **Enforce the CSP:** after a week of clean console logs, rename `Content-Security-Policy-Report-Only` to `Content-Security-Policy` in `netlify.toml`. It still needs `'unsafe-inline'`.
2. Session token in `localStorage` (long term: `HttpOnly` cookie). Not re-checked.
3. Leaderboard and directory read every user record; add an index before growth. Not re-checked.
4. OpenStreetMap Nominatim and tile usage policies. Not re-checked.
5. Search Console verification, custom domain, PageSpeed on the live site.
6. Self-host Google Fonts; compress `logo.png` and `icon-512.png`.
