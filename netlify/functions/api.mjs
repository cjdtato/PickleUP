// PickleUP API: server-authoritative club rating (2.000-8.000), XP, queue, coach sign-off, RBAC.
import { getStore } from "@netlify/blobs";
import { createHash, createHmac, createPublicKey, createVerify, randomBytes, randomInt, timingSafeEqual, scrypt } from "node:crypto";
const scr = (p, salt) => new Promise((res, rej) => scrypt(p, salt, 32, (e, k) => (e ? rej(e) : res(k))));

const NAME = /^[A-Za-z0-9_.-]{3,20}$/, ID = /^[a-z0-9]{1,16}$/, TOK = /^[A-Za-z0-9_.-]{1,64}$/;
const J = (o, s = 200) => Response.json(o, { status: s, headers: { "cache-control": "no-store" } });
const FRESH = 45 * 6e4, fresh = x => Date.now() - x.t < FRESH; // queue entries expire after 45 min
const E = (m, s = 400) => J({ error: m }, s);
const sign = (k, t) => createHmac("sha256", k).update(t).digest("base64url");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const uid = () => randomBytes(5).toString("hex");
const TIERS = ["Beginner", "Intermediate", "Advanced"];
const BADGES = { dink_master: { n: "Dink Master", tier: 1 }, third_shot_pro: { n: "Third-Shot Drop Pro", tier: 2 } };
const POOL = [["Wall dinks: 50 in a row", 15], ["Paddle flips: 3 sets of 20", 10], ["Footwork shadow drill: 5 min", 15],
  ["Soft-hands catch drill: 3 min", 10], ["Serve target practice: 20 serves", 15], ["Split-step shadow rallies: 5 min", 10],
  ["Backhand wall volleys: 3 sets of 15", 15], ["Lateral kitchen-line shuffles: 4 x 30 sec", 10], ["Drop-shot toss-and-catch: 30 reps", 10],
  ["Return-of-serve shadow swings: 30 reps", 10]];
const ROLE = ["player", "certified_coach", "admin"];
const RESERVED = new Set(["admin", "administrator", "root", "system", "support", "staff"]); // can't be registered by the public
const MIX_AFTER = 10 * 6e4; // after this long without 4 in their own tier, players may be matched with the adjacent tier
// Tier ceiling: XP stops growing until the next badge is signed off by a coach. The rating is never capped.
const DAILY = 150; // max XP per day from ranked matches
const CAP = [{ xp: 1000 }, { xp: 3000 }, { xp: Infinity }];
const CONFIRM = 15 * 6e4; // once both teams agree on a score, it auto-validates after this unless someone rejects
const DEF = { courts: ["Court 1", "Court 2", "Court 3", "Court 4"], lat: null, lng: null, rad: 150, minMin: 5, tz: "Asia/Manila", inv: [] };

const jget = async (s, k, d) => (await s.get(k, { type: "json" })) ?? d;
const getU = async (s, id) => norm(await jget(s, "u/" + id, null));
// Cap a log at max entries, dropping the oldest records that are no longer live first (keep(x) = still live).
const trim = (arr, max, keep) => {
  for (let i = 0; i < arr.length && arr.length > max;) keep(arr[i]) ? i++ : arr.splice(i, 1);
  if (arr.length > max) arr.splice(0, arr.length - max);
};
// ---- Concurrency: optimistic compare-and-swap with retry (Netlify Blobs conditional writes) ----
class Bad extends Error { constructor(m, st = 400) { super(m); this.st = st; } }
const SKIP = Symbol("skip");
let warned = false;
// Read key (strong) -> fn(data) edits in place or returns new data (or SKIP) -> write only if nobody changed it meanwhile; else retry.
async function mutate(s, key, def, fn) {
  for (let i = 0; i < 8; i++) {
    const r = await s.getWithMetadata(key, { type: "json", consistency: "strong" });
    const data = r ? r.data : structuredClone(def);
    const nd = await fn(data);
    if (nd === SKIP) return;
    const w = await s.setJSON(key, nd === undefined ? data : nd, r ? { onlyIfMatch: r.etag } : { onlyIfNew: true });
    if (w && w.modified === false) { await new Promise(x => setTimeout(x, 10 + Math.random() * 40 * (i + 1))); continue; }
    if (!w && !warned) { warned = true; console.warn("@netlify/blobs does not report conditional writes: upgrade the package"); }
    return;
  }
  throw new Bad("Server busy, please try again", 503);
}
const mutU = (s, id, fn) => mutate(s, "u/" + id, null, u => { if (!u) throw new Bad("User not found", 404); norm(u); return fn(u); });
// Check-in streak: consecutive days with a completed coach session. Stored as u.st = { n: count, d: last day number }.
const streakNow = (u, tz) => (u.st && u.st.d >= dayN(tz) - 1 ? u.st.n | 0 : 0);
const bumpStreak = (u, tz) => { const d = dayN(tz); if (u.st && u.st.d === d) return u.st.n; u.st = { n: u.st && u.st.d === d - 1 ? (u.st.n | 0) + 1 : 1, d, best: Math.max(u.st ? u.st.best | 0 : 0, u.st && u.st.d === d - 1 ? (u.st.n | 0) + 1 : 1) }; return u.st.n; };
const giveXpStreak = async (s, id, n, tz) => { let k = 0; await mutate(s, "u/" + id, null, u => { if (!u) return SKIP; norm(u); addXp(u, n); k = bumpStreak(u, tz); }); return k; };
const giveXp = (s, id, n) => mutate(s, "u/" + id, null, u => { if (!u) return SKIP; norm(u); addXp(u, n); });
async function createUser(s, u) { // username claimed atomically
  await s.setJSON("u/" + u.id, u);
  const r = await s.set("name/" + u.username.toLowerCase(), u.id, { onlyIfNew: true });
  if (r && r.modified === false) { await s.delete("u/" + u.id); return false; }
  return true;
}
async function loadAll(s) {
  const { blobs } = await s.list({ prefix: "u/" });
  return (await Promise.all(blobs.map(b => s.get(b.key, { type: "json" })))).filter(Boolean).map(norm);
}
const strip = ({ ph, salt, h, tv, dx, g, ...u }) => u;
const tierOf = u => (u.badges.includes("dink_master") ? (u.badges.includes("third_shot_pro") ? 2 : 1) : 0);
// XP past the tier ceiling is banked (max 500) and released when the next badge is signed off.
const addXp = (u, n) => { const g = Math.min(n, Math.max(0, CAP[tierOf(u)].xp - u.xp)); u.xp += g; if (g < n) u.bank = Math.min(500, (u.bank | 0) + n - g); };
const pub = u => ({ ...strip(u), hp: !!(u.h || u.ph), tier: tierOf(u), cap: tierOf(u) < 2 ? CAP[tierOf(u)] : null, rel: reliability(u) });
const newUser = (n, role = "player") => ({ id: uid(), username: n, role, created: Date.now(), disabled: false, tv: 0,
  defaultPw: false, xp: 0, pr: NR_ASSUME, ip: 0, hist: [], badges: [], w: 0, l: 0, done: [], ci: 0, last: "" });

// ---- Club rating, modelled on how DUPR works ----
// 2.000-8.000, three decimals. Before a match the teams' average ratings give an expected share of points;
// the rating moves by (actual share - expected share), so winning by less than expected can lower it and
// losing by less than expected can raise it. Big swings for new/unreliable players, small for established ones,
// capped per match. New players are NR (not rated): they carry a provisional rating (default 3.5, seeded by the
// skill survey or set by a certified coach) until they collect 3 initialization points or 7 days pass.
const RMIN = 2, RMAX = 8, NR_ASSUME = 3.5, SPREAD = 2.28; // SPREAD: a 1.0 rating gap expects roughly 11-4
const MAXMOVE = .2, INIT_PTS = 3, INIT_DAYS = 7;
const r3 = x => Math.round(x * 1000) / 1000;
const clampR = x => Math.min(RMAX, Math.max(RMIN, x));
const rated = u => typeof u.r === "number";
const rtg = u => (rated(u) ? u.r : typeof u.pr === "number" ? u.pr : NR_ASSUME); // value used for expectations and team balancing
const expShare = (a, b) => 1 / (1 + 10 ** (-(a - b) / SPREAD)); // expected share of all points won by team a
const winProb = (a, b) => 1 / (1 + 10 ** (-(a - b) / .8));
// Reliability 1-100%: variety of partners and opposing teams over the last 30 matches, decaying without play.
// 60% needs 2+ partners and 6+ opposing teams; 100% needs 4+ partners and 12+ opposing teams.
function reliability(u) {
  const h = (u.hist || []).slice(-30);
  if (!h.length) return 0;
  const pts = new Set(h.map(x => x.pt)).size, ops = new Set(h.map(x => x.op.slice().sort().join("+"))).size;
  const f = pts >= 4 ? 1 : pts >= 2 ? .6 + .2 * (pts - 2) : .3 * pts;
  const g = ops >= 12 ? 1 : ops >= 6 ? .6 + .4 * (ops - 6) / 6 : .1 * ops;
  const days = (Date.now() - h.at(-1).t) / 864e5, decay = days <= 14 ? 1 : Math.max(.3, 1 - (days - 14) / 300);
  return Math.max(1, Math.round(100 * Math.min(f, g) * decay));
}
// Read-time upgrade of older records: players who already had Elo games get a rating mapped from it
// (1000 -> 3.000, every 400 Elo = 1.0); others start NR. Also finishes a 7-day initialization window.
function norm(u) {
  if (!u) return u;
  if (u.r === undefined && u.pr === undefined) {
    if ((u.w | 0) + (u.l | 0) > 0 && typeof u.elo === "number") u.r = r3(clampR(3 + (u.elo - 1000) / 400));
    else { u.pr = NR_ASSUME; u.ip = 0; }
  }
  if (!rated(u) && u.f && Date.now() - u.f > INIT_DAYS * 864e5) u.r = r3(clampR(rtg(u)));
  u.hist = u.hist || [];
  return u;
}
async function setPw(u, pw) { u.salt = randomBytes(16).toString("hex"); u.h = (await scr(pw, u.salt)).toString("hex"); delete u.ph; }

let SEC; // signing secret never changes once created, so cache it per function instance
async function secret(s) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (SEC) return SEC;
  let k = await s.get("secret");
  if (!k) { // first-ever requests may race: only one candidate wins, everyone re-reads the winner
    const n = randomBytes(32).toString("hex"), r = await s.set("secret", n, { onlyIfNew: true });
    k = r && r.modified === false ? await s.get("secret") : n;
  }
  return (SEC = k);
}
async function byName(s, n) {
  if (!NAME.test(n || "")) return null;
  const id = await s.get("name/" + n.toLowerCase());
  return id ? getU(s, id) : null;
}
let BOOTED = false;
async function boot(s) {
  if (BOOTED) return;
  const ex = await byName(s, "admin");
  if (ex) {
    // Deploys from before v7.2 may still have admin/admin. Once ADMIN_PASSWORD is set, it replaces that
    // default password (and ends any sessions made with it). Until then, login refuses the default.
    if (ex.defaultPw && process.env.ADMIN_PASSWORD) await mutU(s, ex.id, async u => { if (u.defaultPw) { u.tv = (u.tv | 0) + 1; u.defaultPw = false; await setPw(u, process.env.ADMIN_PASSWORD); } });
    return (BOOTED = true);
  }
  // Never fall back to a guessable password: a fresh public deploy would hand admin to whoever logs in first.
  // Without ADMIN_PASSWORD there's nothing to create, so skip the full user scan too.
  if (!process.env.ADMIN_PASSWORD) return;
  if ((await loadAll(s)).some(x => x.role === "admin" && !x.disabled)) return (BOOTED = true);
  const u = newUser("admin", "admin");
  await setPw(u, process.env.ADMIN_PASSWORD);
  await createUser(s, u); BOOTED = true;
}
async function auth(s, req) {
  const [id, exp, tv, sig] = (req.headers.get("authorization") || "").replace("Bearer ", "").split(".");
  if (!sig || !ID.test(id) || Date.now() > +exp) return null;
  if (!same(sig, sign(await secret(s), id + "." + exp + "." + tv))) return null;
  const u = await getU(s, id);
  return u && !u.disabled && String(u.tv | 0) === tv ? u : null;
}
async function token(s, u) {
  const p = u.id + "." + (Date.now() + 30 * 864e5) + "." + (u.tv | 0);
  return p + "." + sign(await secret(s), p);
}
// ---- Sign in with Google ----
// The browser gets a Google ID token (a signed JWT). We check its RS256 signature against Google's published keys,
// plus audience (our client id), issuer, expiry and verified email. Set GOOGLE_CLIENT_ID in Netlify to turn it on.
let GKEYS = { at: 0, keys: [] };
async function googleKeys(force) {
  const age = Date.now() - GKEYS.at;
  if (GKEYS.keys.length && age < 36e5 && !force) return GKEYS.keys;
  if (force && age < 6e4) return GKEYS.keys; // a bogus key id can't make us refetch more than once a minute
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs").catch(() => null);
  if (!r || !r.ok) throw new Bad("Google sign-in is unavailable right now. Try again.", 503);
  GKEYS = { at: Date.now(), keys: (await r.json()).keys || [] };
  return GKEYS.keys;
}
async function googleVerify(cred) {
  const cid = process.env.GOOGLE_CLIENT_ID;
  if (!cid) throw new Bad("Google sign-in is not set up", 503);
  const bad = () => new Bad("Google sign-in failed. Try again.", 401), t = String(cred || ""), p = t.split(".");
  if (t.length > 4096 || p.length !== 3) throw bad();
  let head, c;
  try { head = JSON.parse(Buffer.from(p[0], "base64url").toString()); c = JSON.parse(Buffer.from(p[1], "base64url").toString()); } catch { throw bad(); }
  if (head.alg !== "RS256" || !head.kid) throw bad();
  const jwk = (await googleKeys()).find(k => k.kid === head.kid) || (await googleKeys(true)).find(k => k.kid === head.kid);
  if (!jwk) throw bad();
  let good = false;
  try { good = createVerify("RSA-SHA256").update(p[0] + "." + p[1]).verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(p[2], "base64url")); } catch { /* bad key or signature */ }
  if (!good || c.aud !== cid || !["accounts.google.com", "https://accounts.google.com"].includes(c.iss) || !(c.exp * 1000 > Date.now())) throw bad();
  if (typeof c.sub !== "string" || !c.sub || c.sub.length > 64 || !(c.email_verified === true || c.email_verified === "true") || typeof c.email !== "string") throw bad();
  return { sub: c.sub, email: c.email.toLowerCase().slice(0, 120) };
}
const nameFrom = e => { const n = String(e || "").split("@")[0].replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 20); return NAME.test(n) && !RESERVED.has(n.toLowerCase()) ? n : ""; };
async function verify(s, u, pw) {
  if (!u) { await scr(pw, "x".repeat(32)); return false; }
  if (u.h) return same((await scr(pw, u.salt)).toString("hex"), u.h);
  if (u.ph && same(createHash("sha256").update(u.salt + ":" + pw).digest("hex"), u.ph)) { await mutU(s, u.id, x => setPw(x, pw)); return true; } // upgrade legacy hash
  return false;
}
const rk = k => "rl/" + createHash("sha1").update(k).digest("hex");
async function locked(s, k, max, win) { const r = await jget(s, rk(k), null); return !!r && Date.now() - r.t < win && r.n >= max; }
const hit = (s, k, win) => mutate(s, rk(k), null, r => { const f = r && Date.now() - r.t < win; return { n: f ? r.n + 1 : 1, t: f ? r.t : Date.now() }; });
const dist = (a, b, c, d) => {
  const r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
};
// Check-in codes belong to one event: "op:<open play id>" or "bk:<coach session id>". The code changes every minute and stays valid
// for 3 minutes, so a screenshot is useless an hour later but someone walking up to the host still has time to scan.
const qrNow = () => Math.floor(Date.now() / 6e4);
const qrAt = async (s, scope, w) => sign(await secret(s), "qr:" + scope + ":" + w).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
const qrOk = async (s, scope, c) => { const w = qrNow(); c = String(c || "").trim().toUpperCase(); for (let i = 0; i < 3; i++) if (same(await qrAt(s, scope, w - i), c)) return true; return false; };
const dayN = tz => { try { return Math.floor(Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now())) + "T00:00:00Z") / 864e5); } catch { return Math.floor(Date.now() / 864e5); } };
// Three distinct drills per day, picked by a day-seeded shuffle so the mix changes daily (same for everyone in the club).
const todays = tz => {
  const d = dayN(tz), idx = POOL.map((_, i) => i);
  let r = (d * 2654435761) >>> 0;
  for (let i = idx.length - 1; i > 0; i--) { r = (Math.imul(r ^ (r >>> 15), 2246822507) + 0x6d2b79f5) >>> 0; const j = r % (i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, 3).map(k => ({ id: "d" + d + "-" + k, t: POOL[k][0].split(": ")[0], d: POOL[k][0].split(": ").slice(1).join(": "), xp: POOL[k][1] }));
};

// Weekly challenge (Monday to Sunday, club time zone): finish all 3 daily quests on WEEK_NEED different days for a bonus.
const WEEK_NEED = 4, WEEK_XP = 60;
const weekly = (u, tz) => {
  const d = dayN(tz), wk = Math.floor((d + 3) / 7), start = wk * 7 - 3, done = u.done || [];
  let n = 0;
  for (let i = start; i <= d; i++) if (done.filter(x => x.startsWith("d" + i + "-")).length >= 3) n++;
  return { id: "w" + wk, t: "Weekly challenge", d: `Finish all 3 daily quests on ${WEEK_NEED} days this week`, xp: WEEK_XP, n, need: WEEK_NEED, done: done.includes("w" + wk), left: start + 6 - d };
};

// planFinish runs inside the match CAS (reads only); the winner of that CAS applies the result to each player with a per-user CAS,
// so rating and XP are applied exactly once. XP: underdog upset 2.5x, stomping 0.25x.
// Repeat groups (3+ same players again within 12h) get both XP and rating change damped to 50%, then 25%.
async function planFinish(s, m, sa, sb, ms, tz) {
  const us = await Promise.all(m.p.map(id => getU(s, id)));
  if (us.some(u => !u)) { m.status = "done"; m.void = true; m.end = Date.now(); return null; }
  const ra = (rtg(us[0]) + rtg(us[1])) / 2, rb = (rtg(us[2]) + rtg(us[3])) / 2;
  const EA = expShare(ra, rb), WA = winProb(ra, rb), aw = sa > sb;
  // repeat-group damping: same group (3+ shared players) finishing again within 12h earns less XP
  const repQ = ms.filter(x => x !== m && x.status === "done" && !x.void && Date.now() - x.end < 432e5 && x.p.filter(id => m.p.includes(id)).length >= 3).length;
  // history-based check: covers open play (which passes no match list) and catches repeats across sessions.
  // Games from the same open play session are not counted against each other.
  const seen = new Set();
  us.forEach(u => (u.hist || []).forEach(h => {
    if (h.m === m.id || (m.o && h.o === m.o) || Date.now() - h.t >= 432e5 || seen.has(h.m)) return;
    if ([u.id, h.pt, ...(h.op || [])].filter(id => m.p.includes(id)).length >= 3) seen.add(h.m);
  }));
  const rep = Math.max(repQ, seen.size);
  if (rep >= 2) m.flag = true;
  m.status = "done"; m.sa = sa; m.sb = sb; m.end = Date.now();
  m.exp = r3(EA);
  return { tz, sa, sb, mid: m.id, o: m.o, fl: rep >= 2, rm: rep >= 2 ? .25 : rep >= 1 ? .5 : 1, ids: m.p.slice(), p: us.map((_, i) => {
    const A = i < 2, pt = m.p[[1, 0, 3, 2][i]], op = A ? m.p.slice(2) : m.p.slice(0, 2);
    const ro = us.filter((x, j) => j !== i && rated(x)).length; // rated players among the other three
    return { A, win: A === aw, exp: A ? EA : 1 - EA, wp: A ? WA : 1 - WA, pt, op, ro };
  }) };
}
function applyResult(u, pl, { A, win, exp, wp, pt, op, ro }) {
  const dn = dayN(pl.tz), my = A ? pl.sa : pl.sb, th = A ? pl.sb : pl.sa, nr = !rated(u);
  // rating: actual share of points vs expected share
  const K = nr ? 1 : .25 + .5 * (1 - reliability(u) / 100); // new or unreliable ratings move more
  const w = .5 + .5 * ro / 3;                                // results against unrated players count less
  const d = r3(Math.max(-MAXMOVE, Math.min(MAXMOVE, K * w * pl.rm * (my / (my + th) - exp))));
  if (nr) {
    u.pr = r3(clampR(rtg(u) + d)); u.ip = (u.ip || 0) + Math.max(.0625, ro / 3); u.f = u.f || Date.now();
    if (u.ip >= INIT_PTS) u.r = u.pr;
  } else u.r = r3(clampR(u.r + d));
  // XP
  let xp = 10;
  if (win) xp = Math.round(30 * (wp < .4 ? 2.5 : wp > .7 ? .25 : 1));
  const raw = xp; xp = Math.round(xp * pl.rm);
  if (!u.dx || u.dx.d !== dn) u.dx = { d: dn, n: 0 };
  xp = Math.max(0, Math.min(xp, DAILY - u.dx.n)); u.dx.n += xp;
  const x0 = u.xp; addXp(u, xp); win ? u.w++ : u.l++;
  const gx = u.xp - x0;
  u.hist = [...(u.hist || []), { t: Date.now(), m: pl.mid, o: pl.o, rm: pl.rm, pt, op, s: [my, th], d, w: win, nr, ex: r3(exp) }].slice(-30);
  u.last = `${win ? "Won" : "Lost"} ${my}-${th}: rating ${d >= 0 ? "+" : ""}${d.toFixed(3)}${nr ? (rated(u) ? " (now rated)" : " (provisional)") : ""}, +${gx} XP`
    + (gx < xp ? " (XP ceiling: banked)" : "") + (xp < raw ? " (XP reduced: daily cap or repeat group)" : "");
}
async function applyPlan(s, pl, quiet) {
  if (!pl) return;
  const r = await Promise.allSettled(pl.ids.map((id, i) => mutU(s, id, u => applyResult(u, pl, pl.p[i]))));
  r.forEach(x => x.status === "rejected" && console.error("applyPlan", x.reason));
  if (!quiet) await board(s, true).catch(e => console.warn("board refresh", e.message)); // rankings reflect the result immediately
}
// Housekeeping on the match list: auto-validate scores both teams agreed on CONFIRM ago (nobody rejected),
// void abandoned matches (3h) and any match left in an unknown state by an older version (disputes no longer exist).
async function expire(s, tz) {
  const plans = [];
  await mutate(s, "m", [], async ms => {
    plans.length = 0;
    let ch = false;
    for (const m of ms) {
      if (m.status === "playing" && m.cf && Date.now() - m.cf >= CONFIRM) {
        const [x, y] = Object.values(m.sub)[0]; m.auto = true;
        plans.push(await planFinish(s, m, x, y, ms, tz)); ch = true;
      } else if ((m.status === "playing" && Date.now() - m.start > 3 * 36e5) || (m.status !== "playing" && m.status !== "done")) { m.status = "done"; m.void = true; m.end = Date.now(); ch = true; }
    }
    return ch ? undefined : SKIP;
  });
  for (const p of plans) await applyPlan(s, p);
}
// Matches are created inside the "m" CAS (court + player exclusivity can't be violated), then used players leave the queue.
async function matchmake(s, cfg) {
  await expire(s, cfg.tz);
  const used = new Set();
  await mutate(s, "m", [], async ms => {
    used.clear();
    const q = (await jget(s, "q", [])).filter(fresh), act = ms.filter(m => m.status !== "done");
    const busy = new Set(act.map(m => m.court)), inM = new Set(act.flatMap(m => m.p));
    let ch = false;
    const avail = x => !inM.has(x.id);
    const start = async (t, four, mixed) => {
      const free = cfg.courts.find(c => !busy.has(c));
      if (!free) return false;
      const us = await Promise.all(four.map(x => getU(s, x.id)));
      const bad = four.filter((_, i) => !us[i] || us[i].disabled);
      if (bad.length) { bad.forEach(f => { inM.add(f.id); used.add(f.id); }); return true; } // drop dead entries from the queue, keep going
      us.sort((a, b) => rtg(b) - rtg(a)); // strongest + weakest vs the middle two
      ms.push({ id: uid(), court: free, tier: t, mixed: mixed || undefined, p: [us[0].id, us[3].id, us[1].id, us[2].id], start: Date.now(), status: "playing", sub: {} });
      busy.add(free); four.forEach(f => { inM.add(f.id); used.add(f.id); }); ch = true;
      return true;
    };
    // Pass 1: same-tier matches, as many as there are free courts (oldest in queue first).
    for (let t = 0; t < 3; t++) {
      for (let row; (row = q.filter(x => x.tier === t && avail(x))).length >= 4;) if (!(await start(t, row.slice(0, 4)))) break;
    }
    // Pass 2: a tier that can't fill a court and has waited MIX_AFTER may borrow from the adjacent tier(s).
    for (let t = 0; t < 3; t++) {
      for (let row; (row = q.filter(x => x.tier === t && avail(x))).length && Date.now() - row[0].t >= MIX_AFTER;) {
        const pool = [t + 1, t - 1].map(nb => row.concat(q.filter(x => x.tier === nb && avail(x)))).find(p => p.length >= 4); // one neighbour tier only
        if (!pool || !(await start(t, pool.slice(0, 4), true))) break;
      }
    }
    for (let i = 0; i < ms.length && ms.length > 300;) ms[i].status === "done" ? ms.splice(i, 1) : i++;
    return ch ? undefined : SKIP;
  });
  if (used.size) await mutate(s, "q", [], q => q.filter(x => fresh(x) && !used.has(x.id)));
}

// ---- Friends and chat ----
// One small record per player: f = friends (with unread count un and last-message time lm), i = requests received, o = requests sent.
// Names are stored beside the ids (usernames never change), so listing friends costs one read.
const FR0 = { f: [], i: [], o: [] }, FMAX = 200;
const frOf = async (s, id) => { const x = await jget(s, "fr/" + id, FR0); return { f: x.f || [], i: x.i || [], o: x.o || [] }; };
const mutF = (s, id, fn) => mutate(s, "fr/" + id, FR0, r => { r.f ||= []; r.i ||= []; r.o ||= []; return fn(r); });
const ck = (x, y) => "c/" + [x, y].sort().join("_");
const befriend = (s, x, y) => Promise.all([[x, y], [y, x]].map(([p, q]) => mutF(s, p.id, r => {
  r.i = r.i.filter(z => z.id !== q.id); r.o = r.o.filter(z => z.id !== q.id);
  if (!r.f.some(z => z.id === q.id)) r.f.push({ id: q.id, n: q.n, un: 0, lm: 0 });
})));
const unfriend = (s, x, y) => Promise.all([[x, y], [y, x]].map(([p, q]) => mutF(s, p, r => {
  r.f = r.f.filter(z => z.id !== q); r.i = r.i.filter(z => z.id !== q); r.o = r.o.filter(z => z.id !== q);
})));
// Conversation view for one friend; opening it clears that friend's unread count. since = newest message the client already has.
async function thread(s, me, id, since) {
  const fr = await frOf(s, me.id), f = fr.f.find(x => x.id === id);
  if (!f) throw new Bad("You can only message friends", 403);
  if (f.un) await mutF(s, me.id, r => { const x = r.f.find(z => z.id === id); if (!x || !x.un) return SKIP; x.un = 0; });
  const m = await jget(s, ck(me.id, id), []);
  if (since && (m.at(-1)?.t || 0) <= since) return J({ same: true, n: f.n });
  return J({ n: f.n, msgs: m.slice(-100) });
}

// ---- Chat read markers (v8.18): one small record per player, {"op:<id>": newest message time they have seen}. Capped at LRMAX keys.
const LRMAX = 60, PINMAX = 200;
const lrSet = (s, id, key, t) => mutate(s, "lr/" + id, {}, r => {
  if ((r[key] || 0) >= t) return SKIP;
  r[key] = t;
  const ks = Object.keys(r);
  if (ks.length > LRMAX) ks.sort((x, y) => r[x] - r[y]).slice(0, ks.length - LRMAX).forEach(k => delete r[k]);
});
const bkUn = async (s, me, b) => b.status === "booked" && b.ts > Date.now() - 864e5 ? unreadOf(await jget(s, `gc/bk_${b.id}`, []), me.id, (await jget(s, "lr/" + me.id, {}))["bk:" + b.id] || 0) : 0;
const unreadOf = (m, me, t0) => { let n = 0; for (let i = m.length - 1; i >= 0 && m[i].t > t0; i--) if (m[i].f !== me) n++; return n; };

// ---- Hosted open play ----
// A host publishes an open play (title, place, time, price). Players join and pay the host directly (GCash or another e-wallet,
// same as coach sessions: the app tracks payment, it doesn't process it). Once the host starts it, the app builds a randomized
// queue of games from the paid players so everyone gets the same number of games, puts the first games on the free courts, and
// keeps a ranking from the scores. Stored as one list under "op"; each game is {id, n, p:[a,b,c,d], court, st: q|p|d, sa, sb}.
const OPLIVE = e => (e.status === "open" || e.status === "live") && e.ts + e.dur * 6e4 + 6 * 36e5 > Date.now();
const OPRECENT = e => (e.status === "ended" || e.status === "cancelled") && (e.ended || e.ts) > Date.now() - 3 * 864e5;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// Who gets games: paid players who also scanned in. Open plays made before check-in existed (no e.qr) keep the old paid-only rule.
const here = (e, x) => x.id === e.host ? !!x.ci : (!e.qr || !!x.ci); // the host is listed as a player but only plays once checked in
const inPlay = e => e.pl.filter(x => x.paid && !x.left && here(e, x));
// Fixed pairs: team A and team B each keep their pair together; unpaired players are matched with each other. null = can't, use the random split.
function pairedFour(order, pr) {
  const used = new Set(), team = () => {
    const p = order.find(x => !used.has(x)); if (p == null) return null;
    let m = pr.get(p); if (m == null || used.has(m)) m = pr.has(p) ? null : order.find(x => x !== p && !used.has(x) && !pr.has(x));
    if (m == null) return null; used.add(p); used.add(m); return [p, m];
  };
  const a = team(), b = a && team(); return a && b ? [...a, ...b] : null;
}
// Top up the queue until every paid player has e.rounds games. Fewest games first, ties broken at random, teams split at random.
function opFill(e) {
  const ps = inPlay(e).map(x => x.id);
  if (ps.length < 4) return;
  const cnt = new Map(ps.map(id => [id, 0])), pr = new Map();
  e.g.forEach(g => g.p.forEach(id => cnt.has(id) && cnt.set(id, cnt.get(id) + 1)));
  if (e.fp) (e.pairs || []).forEach(([a, b]) => { if (cnt.has(a) && cnt.has(b)) { pr.set(a, b); pr.set(b, a); } }); // fixed pairs that are both checked in
  for (let n = 0; n < 400; n++) {
    const order = shuffle(ps.slice()).sort((x, y) => cnt.get(x) - cnt.get(y)); // stable sort: the shuffle decides ties
    if (cnt.get(order[0]) >= e.rounds) break;
    const four = (pr.size && pairedFour(order, pr)) || shuffle(order.slice(0, 4));
    four.forEach(id => cnt.set(id, cnt.get(id) + 1));
    e.g.push({ id: uid(), n: ++e.seq, p: four, court: null, st: "q" });
  }
}
// Put queued games on free courts, never a player who is already on court.
function opAdvance(e) {
  const on = e.g.filter(g => g.st === "p"), busy = new Set(on.map(g => g.court)), used = new Set(on.flatMap(g => g.p));
  for (let c = 1; c <= e.courts; c++) {
    if (busy.has(c)) continue;
    const g = e.g.find(x => x.st === "q" && !x.p.some(id => used.has(id)));
    if (!g) continue;
    g.st = "p"; g.court = c; g.t0 = Date.now(); g.p.forEach(id => used.add(id));
  }
}
const opSync = e => { if (e.status === "live") { opFill(e); opAdvance(e); } };
// Remove a player from every game that has not finished (queued or on court); the queue is topped up afterwards.
const dropOpen = (e, id) => { e.g = e.g.filter(g => g.st === "d" || !g.p.includes(id)); };
// Ranking inside one open play: wins, then point difference, then points scored.
function opRank(e) {
  const m = new Map(e.pl.map(x => [x.id, { id: x.id, n: x.n, g: 0, w: 0, l: 0, pf: 0, pa: 0 }]));
  for (const g of e.g) if (g.st === "d") for (const [a, b, f, c] of [[0, 1, g.sa, g.sb], [2, 3, g.sb, g.sa]]) for (const k of [a, b]) {
    const r = m.get(g.p[k]); if (!r) continue;
    r.g++; r.pf += f; r.pa += c; f > c ? r.w++ : r.l++;
  }
  return [...m.values()].filter(r => r.g || e.pl.some(x => x.id === r.id && x.paid && !x.left))
    .sort((a, b) => b.w - a.w || (b.pf - b.pa) - (a.pf - a.pa) || b.pf - a.pf || a.n.localeCompare(b.n));
}
// ---- Venue (court details + map pin), shared by open plays and coach sessions ----
// Stored as { a: address, lat, lng (both null when there is no pin), set: indoor|outdoor|covered, sf: surface, ct: court number/area, am: [facilities], nt: notes }.
const VEN_SET = ["indoor", "outdoor", "covered"], VEN_SF = ["dedicated", "concrete", "asphalt", "wood", "tile", "other"];
const VEN_AM = ["lights", "shade", "restrooms", "parking", "water", "nets", "rental", "store"];
function cleanVen(v) {
  v = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const one = (x, n) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const has = x => x !== null && x !== undefined && x !== "";
  let lat = null, lng = null;
  if (has(v.lat) || has(v.lng)) {
    lat = has(v.lat) ? +v.lat : NaN; lng = has(v.lng) ? +v.lng : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Bad("The map pin looks wrong. Pin the place again.");
    lat = Math.round(lat * 1e6) / 1e6; lng = Math.round(lng * 1e6) / 1e6;
  }
  return { a: one(v.a, 120), lat, lng, set: VEN_SET.includes(v.set) ? v.set : "", sf: VEN_SF.includes(v.sf) ? v.sf : "", ct: one(v.ct, 40),
    am: [...new Set((Array.isArray(v.am) ? v.am : []).filter(x => VEN_AM.includes(x)))], nt: String(v.nt ?? "").replace(/\r/g, "").trim().slice(0, 200) };
}
const opLine = (e, me) => ({ id: e.id, club: e.club || null, cn: e.cn || "", mode: e.mode || "casual", fp: !!e.fp, sw: !!e.sw, skill: e.skill || "All levels", title: e.title, loc: e.loc, pin: e.ven?.lat != null, ts: e.ts, dur: e.dur, price: e.price, cap: e.cap, n: e.pl.filter(x => !x.left).length, st: e.status, hn: e.hn,
  mine: e.host === me.id, joined: e.pl.some(x => x.id === me.id && !x.left), paid: e.pl.some(x => x.id === me.id && x.paid && !x.left) });
function opDetail(e, me) {
  const host = e.host === me.id, joined = e.pl.some(x => x.id === me.id && !x.left), done = e.g.filter(g => g.st === "d");
  return { id: e.id, club: e.club || null, cn: e.cn || "", mode: e.mode || "casual", fp: !!e.fp, sw: !!e.sw, pairs: e.pairs || [], skill: e.skill || "All levels", applied: !!e.applied, title: e.title, desc: e.desc, loc: e.loc, ven: e.ven || null, ts: e.ts, dur: e.dur, price: e.price, pay: host || joined ? e.pay : "", cap: e.cap, courts: e.courts, rounds: e.rounds,
    st: e.status, host: e.host, hn: e.hn, isHost: host, joined, now: Date.now(), qr: !!e.qr,
    pl: e.pl.filter(x => !x.left || e.g.some(g => g.p.includes(x.id)) || (host && x.cr)).map(x => ({ id: x.id, n: x.n, paid: !!x.paid, here: here(e, x), out: !!x.out, left: !!x.left, cr: !!x.cr, me: x.id === me.id, ref: host || x.id === me.id ? x.ref || "" : "" })),
    g: [...e.g.filter(g => g.st !== "d"), ...done.slice(-30)].map(g => ({ id: g.id, n: g.n, p: g.p, c: g.court, st: g.st, sa: g.sa, sb: g.sb, cf: g.cf || null })),
    total: e.g.length, finished: done.length, rank: opRank(e) };
}
// Edit one open play under compare-and-swap; fn edits it in place. Returns the saved copy.
async function mutOp(s, id, fn) {
  let out;
  await mutate(s, "op", [], async list => {
    const e = list.find(x => x.id === id);
    if (!e) throw new Bad("Open play not found", 404);
    await fn(e, list);
    out = structuredClone(e);
  });
  return out;
}

// Player index for the leaderboard and the Players directory: every active non-admin, rated first by rating.
async function board(s, force) {
  const c = force ? null : await jget(s, "board", null);
  if (c && c.v === 3 && Date.now() - c.t < 6e4) return c.rows;
  const rows = (await loadAll(s)).filter(u => u.role !== "admin" && !u.disabled)
    .map(u => ({ id: u.id, n: u.username, r: rated(u) ? u.r : null, rel: reliability(u), x: u.xp, t: tierOf(u), w: u.w | 0, l: u.l | 0, c: u.role === "certified_coach" || undefined, a: u.av || undefined, la: u.la || 0 }))
    .sort((a, b) => (b.r ?? -1) - (a.r ?? -1) || a.n.localeCompare(b.n));
  await s.setJSON("board", { v: 3, t: Date.now(), rows });
  return rows;
}
// Personal match log: one list per player under mh/<id>, written when an open play ends (casual and ranked alike),
// so a player's history follows them across every open play. Rating changes of ranked games are joined in from u.hist when read.
const MHMAX = 500;
async function logGames(s, e) {
  const per = new Map();
  for (const g of e.g) {
    if (g.st !== "d" || g.p.length < 4) continue;
    const t = g.t1 || e.ended || Date.now();
    [[0, 1, 2, 3, g.sa, g.sb], [1, 0, 2, 3, g.sa, g.sb], [2, 3, 0, 1, g.sb, g.sa], [3, 2, 0, 1, g.sb, g.sa]].forEach(([me, pt, o1, o2, my, th]) =>
      (per.get(g.p[me]) || per.set(g.p[me], []).get(g.p[me])).push({ t, o: e.id, ot: e.title, k: e.mode || "casual", g: g.id, pt: g.p[pt], op: [g.p[o1], g.p[o2]], s: [my, th], w: my > th }));
  }
  await Promise.all([...per].map(([id, rows]) => mutate(s, "mh/" + id, [], list => {
    const have = new Set(list.map(x => x.g)), add = rows.filter(r => !have.has(r.g));
    if (!add.length) return SKIP;
    list.push(...add); list.sort((a, b) => a.t - b.t);
    if (list.length > MHMAX) list.splice(0, list.length - MHMAX);
  }).catch(x => console.error("match log", x))));
}
// Everything a player has played, newest first: the personal log plus older rated matches that predate it.
async function history(s, u, max = 50) {
  const log = await jget(s, "mh/" + u.id, []), by = new Map((u.hist || []).map(h => [h.m, h]));
  const rows = log.map(x => { const h = x.k === "ranked" ? by.get(x.g) : null; return { ...x, d: h ? h.d : undefined, nr: h ? !!h.nr : false, ex: h ? h.ex : undefined }; });
  const seen = new Set(log.map(x => x.g));
  (u.hist || []).filter(h => !seen.has(h.m)).forEach(h => rows.push({ t: h.t, k: "ranked", pt: h.pt, op: h.op, s: h.s, w: h.w, d: h.d, nr: !!h.nr, ex: h.ex }));
  return rows.sort((a, b) => b.t - a.t).slice(0, max);
}
// Public profile: what any club member can see about another player.
async function profile(s, id, self) {
  const u = await getU(s, id);
  if (!u || (!self && (u.disabled || u.role === "admin"))) return null;
  const [cl, hs, rows] = await Promise.all([jget(s, "cl", []), history(s, u), board(s)]);
  const cls = cl.filter(c => isMember(c, u.id)).map(clubRef), ids = [...new Set(hs.flatMap(h => [h.pt, ...h.op]))], known = new Map(rows.map(r => [r.id, r.n]));
  // one cached board read covers most names; only players missing from it (disabled, brand new) cost a user read
  const names = new Map(await Promise.all(ids.map(async i => [i, known.get(i) || (await getU(s, i))?.username || "Former player"])));
  return { id: u.id, n: u.username, a: u.av || undefined, cv: u.cv || undefined, r: rated(u) ? u.r : null, pr: rated(u) ? null : rtg(u), ip: u.ip || 0, rel: reliability(u), w: u.w | 0, l: u.l | 0,
    t: tierOf(u), badges: u.badges, coach: u.role === "certified_coach", src: u.src || null, since: u.created, sk: u.sk || null, xp: u.xp,
    clubs: cls,
    hist: hs.map(h => ({ t: h.t, rm: h.rm, s: h.s, d: h.d, w: h.w, nr: !!h.nr, ex: h.ex, k: h.k, ot: h.ot, pt: names.get(h.pt), op: h.op.map(i => names.get(i)) })) };
}
async function coaches(s, force) {
  let c = force ? null : await jget(s, "coaches", null);
  if (!c) { c = (await loadAll(s)).filter(u => u.role === "certified_coach" && !u.disabled).map(u => ({ id: u.id, n: u.username, pay: u.pay || "" })); await s.setJSON("coaches", c); }
  return c;
}
// ---- Clubs ----
// One list "cl": {id, name, desc, rules, loc, ap (owner approves joiners), ho (only the owner hosts), rq: [{id, n, at}], owner, on (owner name), made, m: [{id, at}]}. Any player or coach can create clubs and join several.
// Every open play belongs to one of the host's clubs. Club ranking = average club rating of the members who have one (NR players don't count).
const CLNAME = /^[A-Za-z0-9 _.&'-]{3,30}$/;
const isMember = (c, id) => c.m.some(x => x.id === id);
const clubRef = c => ({ id: c.id, n: c.name });
const canHost = (c, id) => !c.ho || c.owner === id;
// Only the fields the caller actually sent: an update with just a name must not reset the rest.
function clubFields(b) {
  const has = k => b[k] !== undefined && b[k] !== null, f = {};
  if (has("desc")) f.desc = String(b.desc).trim().slice(0, 200);
  if (has("rules")) f.rules = String(b.rules).trim().slice(0, 1000);
  if (has("loc")) f.loc = String(b.loc).trim().slice(0, 60);
  if (has("ap")) f.ap = b.ap === true;
  if (has("ho")) f.ho = b.ho === true;
  return f;
}
const CLDEFAULTS = { desc: "", rules: "", loc: "", ap: false, ho: false };
const cleanName = x => String(x || "").trim().replace(/\s+/g, " ");
function clubStats(c, rows) {
  const by = new Map(rows.map(r => [r.id, r])), act = c.m.map(x => by.get(x.id)).filter(Boolean), rated = act.filter(r => r.r != null);
  return { act, n: act.length, rn: rated.length, avg: rated.length ? r3(rated.reduce((t, r) => t + r.r, 0) / rated.length) : null };
}
async function clubBoard(s, me) {
  const [cl, rows] = await Promise.all([jget(s, "cl", []), board(s)]);
  return cl.map(c => { const st = clubStats(c, rows); return { id: c.id, n: c.name, d: c.desc, loc: c.loc || "", ap: !!c.ap, on: c.on, m: st.n, rm: st.rn, avg: st.avg, joined: isMember(c, me.id), req: (c.rq || []).some(x => x.id === me.id), mine: c.owner === me.id }; })
    .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || b.m - a.m || a.n.localeCompare(b.n));
}
async function clubDetail(s, me, id) {
  const [cl, rows, ops] = await Promise.all([jget(s, "cl", []), board(s), jget(s, "op", [])]);
  const c = cl.find(x => x.id === id);
  if (!c) throw new Bad("Club not found", 404);
  const st = clubStats(c, rows);
  const mgr = c.owner === me.id || me.role === "admin";
  return { id: c.id, n: c.name, cv: c.cv || undefined, d: c.desc, rules: c.rules || "", loc: c.loc || "", ap: !!c.ap, ho: !!c.ho, canHost: canHost(c, me.id), on: c.on, owner: c.owner, isOwner: c.owner === me.id, mgr, joined: isMember(c, me.id),
    requested: (c.rq || []).some(x => x.id === me.id), rq: mgr ? (c.rq || []).map(x => ({ id: x.id, n: x.n, at: x.at })) : [], made: c.made, m: st.n, rm: st.rn, avg: st.avg,
    mem: st.act.map(r => ({ id: r.id, n: r.n, r: r.r, rel: r.rel, w: r.w, l: r.l, c: !!r.c, o: r.id === c.owner })).sort((a, b) => (b.r ?? -1) - (a.r ?? -1) || a.n.localeCompare(b.n)),
    ops: ops.filter(e => e.club === id && OPLIVE(e)).sort((a, b) => a.ts - b.ts).map(e => opLine(e, me)) };
}
async function snapshot(s, me, cfg, full, pre = {}) {
  const names = new Map(), nm = id => { if (!names.has(id)) names.set(id, getU(s, id).then(u => u?.username || "?")); return names.get(id); };
  const [ms, q, bk, hw, co, bd, ss, fr, ops, cls] = await Promise.all([pre.m || jget(s, "m", []), pre.q || jget(s, "q", []), jget(s, "bk", []), jget(s, "hw", []), coaches(s), board(s), jget(s, "ss", []), frOf(s, me.id), jget(s, "op", []), jget(s, "cl", [])]);
  const qf = q.filter(fresh), live = bk.filter(b => b.status !== "cancelled"), sm = new Map(ss.map(x => [x.id, x])), cn = new Map(co.map(c => [c.id, c.n])), cp = new Map(co.map(c => [c.id, c.pay]));
  const mm = ms.filter(m => m.p.includes(me.id) && m.status !== "done" && Date.now() - m.start < 3 * 36e5).pop();
  const out = {
    me: pub(me), avs: Object.fromEntries(bd.filter(r => r.a).map(r => [r.n, r.a])), tiers: TIERS, badgeDefs: BADGES, streak: streakNow(me, cfg.tz), bestStreak: me.st ? me.st.best | 0 : 0, weekly: weekly(me, cfg.tz), today: todays(cfg.tz).map(x => ({ ...x, done: me.done.includes(x.id) })),
    checked: Date.now() - me.ci < 4 * 36e5, inQueue: qf.some(x => x.id === me.id), qSince: qf.find(x => x.id === me.id)?.t || null, mixAfter: MIX_AFTER,
    queue: TIERS.map((_, t) => qf.filter(x => x.tier === t).length),
    match: mm ? await (async () => {
      const us = await Promise.all(mm.p.map(id => getU(s, id))), side = mm.p.indexOf(me.id) < 2 ? 0 : 1;
      const ra = (rtg(us[0]) + rtg(us[1])) / 2, rb = (rtg(us[2]) + rtg(us[3])) / 2, first = Object.values(mm.sub)[0] || null;
      return { id: mm.id, court: mm.court, status: mm.status, start: mm.start, minMin: cfg.minMin, mixed: !!mm.mixed,
        A: [await nm(mm.p[0]), await nm(mm.p[1])], B: [await nm(mm.p[2]), await nm(mm.p[3])],
        Ar: us.slice(0, 2).map(u => (rated(u) ? u.r : null)), Br: us.slice(2).map(u => (rated(u) ? u.r : null)),
        side, exp: r3(side ? 1 - expShare(ra, rb) : expShare(ra, rb)), sent: !!mm.sub[me.id], mine: mm.sub[me.id] || null,
        agreed: first, nsub: Object.keys(mm.sub).length, cf: mm.cf || null, confirm: CONFIRM,
        unlock: mm.start + cfg.minMin * 6e4, now: Date.now(), // server clock, so countdowns don't depend on the phone's clock
        // each player's part in recording the score: the first to submit "entered" it, matching submissions "confirmed"
        ppl: await Promise.all(mm.p.map(async (id, i) => ({ n: await nm(id), team: i < 2 ? 0 : 1, me: id === me.id,
          st: !mm.sub[id] ? "waiting" : id === Object.keys(mm.sub)[0] ? "entered" : "confirmed" }))),
        enteredBy: Object.keys(mm.sub).length ? await nm(Object.keys(mm.sub)[0]) : null,
        allNR: us.every(u => !rated(u)) };
    })() : null,
    sessions: ss.filter(x => x.status === "open" && x.ts > Date.now()).sort((a, b) => a.ts - b.ts).slice(0, 40).map(x => {
      const n = live.filter(b => b.sid === x.id);
      return { id: x.id, coach: cn.get(x.coach) || "Coach", kind: x.kind, ts: x.ts, title: x.title, loc: x.loc || "", ven: x.ven || null, price: x.price, dur: x.dur || 60, left: x.cap - n.length, mine: n.some(b => b.player === me.id), own: x.coach === me.id };
    }),
    bookings: await Promise.all(bk.filter(b => b.player === me.id).slice(-10).map(async b => ({ ...b, un: await bkUn(s, me, b), cn: await nm(b.coach), pay: cp.get(b.coach) || "", dur: b.dur || sm.get(b.sid)?.dur || 60, title: sm.get(b.sid)?.title || b.kind, loc: sm.get(b.sid)?.loc || "", ven: sm.get(b.sid)?.ven || null }))),
    homework: await Promise.all(hw.filter(h => h.student === me.id).slice(-15).map(async h => ({ ...h, cn: await nm(h.coach) }))),
    board: bd.filter(u => u.r != null).slice(0, 25).map(u => ({ ...u, me: u.id === me.id })),
    friends: { f: fr.f.map(x => ({ ...x, la: bd.find(r => r.id === x.id)?.la || 0 })).sort((a, b) => (b.lm | 0) - (a.lm | 0) || a.n.localeCompare(b.n)), i: fr.i, o: fr.o }, unread: fr.f.reduce((t, x) => t + (x.un | 0), 0),
    myClubs: cls.filter(c => isMember(c, me.id)).map(c => ({ ...clubRef(c), o: c.owner === me.id, h: canHost(c, me.id) })),
    ops: [
      ...ops.filter(OPLIVE).sort((a, b) => (b.status === "live") - (a.status === "live") || a.ts - b.ts).slice(0, 40),
      // finished open plays are public for the retention window, not just for the host and players
      ...ops.filter(e => OPRECENT(e) && e.status === "cancelled").sort((a, b) => b.ts - a.ts).slice(0, 20),
      ...ops.filter(e => OPRECENT(e) && e.status === "ended").sort((a, b) => b.ts - a.ts).slice(0, 20),
    ].map(e => opLine(e, me)),
  };
  { // unread chat per open play you are in (v8.18): one read marker + at most 5 chat reads
    const mineOp = out.ops.filter(e => (e.mine || e.joined) && (e.st === "open" || e.st === "live")).slice(0, 5);
    if (mineOp.length) {
      const lrm = await jget(s, "lr/" + me.id, {});
      await Promise.all(mineOp.map(async e => { e.un = unreadOf(await jget(s, `gc/op_${e.id}`, []), me.id, lrm["op:" + e.id] || 0); }));
    }
  }
  if (me.role !== "player") {
    // roster = durable list on the coach record (survives booking-log trimming) + anything still in the log
    const mine = bk.filter(b => b.coach === me.id), sid = [...new Set([...(me.stu || []), ...mine.filter(b => b.status === "attended").map(b => b.player)])];
    out.coach = {
      bookings: await Promise.all(mine.slice(-30).reverse().map(async b => ({ ...b, un: await bkUn(s, me, b), pn: await nm(b.player), title: sm.get(b.sid)?.title }))),
      students: (await Promise.all(sid.map(id => getU(s, id)))).filter(Boolean).map(u => ({ id: u.id, n: u.username, t: tierOf(u), r: rated(u) ? u.r : null })),
      hw: await Promise.all(hw.filter(h => h.coach === me.id).slice(-30).reverse().map(async h => ({ ...h, sn: await nm(h.student) }))),
      sessions: ss.filter(x => x.coach === me.id && x.status === "open" && x.ts > Date.now() - 36e5).sort((a, b) => a.ts - b.ts).slice(0, 40)
        .map(x => ({ id: x.id, kind: x.kind, ts: x.ts, dur: x.dur || 60, title: x.title, loc: x.loc || "", ven: x.ven || null, price: x.price, cap: x.cap, booked: live.filter(b => b.sid === x.id).length })),
      who: Object.fromEntries(await Promise.all([...new Set(live.filter(b => b.coach === me.id).map(b => b.sid))].map(async sid => [sid, await Promise.all(live.filter(b => b.sid === sid).map(b => nm(b.player)))]))),
      revenue: mine.filter(b => b.paid && b.status !== "cancelled").reduce((t, b) => t + (b.price | 0), 0),
      due: mine.filter(b => !b.paid && b.status !== "cancelled").reduce((t, b) => t + (b.price | 0), 0) };
  }
  if (me.role === "admin") {
    out.admin = { cfg };
    out.admin.flags = await Promise.all([...ms.filter(m => m.flag), ...(await jget(s, "fl", []))].slice(-8).map(async m => ({ id: m.id, names: await Promise.all(m.p.map(id => nm(id))) })));
    if (full) out.admin.users = (await loadAll(s)).map(u => { const p = pub(u); delete p.hist; return p; });
  }
  return out;
}
// games to 11, 15 or 21, win by 2 (extended games end exactly 2 apart)
const validScore = (x, y) => { const hi = Math.max(x, y), lo = Math.min(x, y); return int(x, 0, 40) && int(y, 0, 40) && hi - lo >= 2 && ([11, 15, 21].includes(hi) || (hi > 11 && hi - lo === 2)); };
const goodStr = x => typeof x === "string" && TOK.test(x);
const int = (x, a, b) => Number.isInteger(x) && x >= a && x <= b;

const AVRE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/;
const PWMIN = 8; // v8.26: minimum length for new and changed passwords (existing 6-character passwords can still log in)
const imgOk = (d) => { // v8.26: the bytes must match the claimed type, not just the data-URL prefix
  const m = typeof d === "string" && AVRE.exec(d); if (!m) return false;
  const b = Buffer.from(m[2].slice(0, 24), "base64"), t = m[1];
  if (t === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (t === "image/png") return b.length > 7 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return b.length > 11 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP";
};
const COVMAX = 300000; // cover photos are wide (about 1200x480) so they get a bigger cap than profile pictures
async function handle(req, context) {
  if (req.method === "GET") { // profile photo: /api?avatar=<username>&v=<version>; the version makes it safe to cache for a year
    const q = new URL(req.url).searchParams, n = q.get("avatar");
    if (!n && (q.get("cover") || q.get("clubcover"))) { // cover photos: /api?cover=<username>&v=<version> or /api?clubcover=<club id>&v=<version>
      const s = getStore({ name: "the-system", consistency: "strong" });
      let key = null;
      if (q.get("cover")) { const u = await byName(s, q.get("cover")); if (u && u.cv && !u.disabled) key = "cv/" + u.id; }
      else if (ID.test(q.get("clubcover"))) { const c = (await jget(s, "cl", [])).find(x => x.id === q.get("clubcover")); if (c && c.cv) key = "cvc/" + c.id; }
      const d = key ? await s.get(key, { type: "text" }) : null, m = d && AVRE.exec(d);
      if (!m) return new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=60" } });
      return new Response(Buffer.from(m[2], "base64"), { headers: { "content-type": m[1], "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
    }
    if (!n && q.get("chatimg")) { // open play chat photo: /api?chatimg=<24 hex id>; ids are random, so only people who saw the chat can know them
      const id = q.get("chatimg"), s = getStore({ name: "the-system", consistency: "strong" });
      const d = /^[a-f0-9]{24}$/.test(id) ? await s.get("ci/" + id, { type: "text" }) : null, m = d && AVRE.exec(d);
      if (!m) return new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=60" } });
      return new Response(Buffer.from(m[2], "base64"), { headers: { "content-type": m[1], "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
    }
    if (!n) return E("POST only", 405);
    const s = getStore({ name: "the-system", consistency: "strong" }), u = await byName(s, n);
    const d = u && u.av && !u.disabled ? await s.get("av/" + u.id, { type: "text" }) : null, m = d && AVRE.exec(d);
    if (!m) return new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=60" } });
    return new Response(Buffer.from(m[2], "base64"), { headers: { "content-type": m[1], "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
  }
  if (req.method !== "POST") return E("POST only", 405);
  let b; try { b = await req.json(); } catch { return E("bad json"); }
  const s = getStore({ name: "the-system", consistency: "strong" }), a = b.action;
  const cfg = { ...DEF, ...(await jget(s, "cfg", {})) };

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "?";
  if (a === "login") { // lockout is per username+IP (8 tries), so a stranger can't lock a real user out; a high per-username cap (60) still stops distributed guessing
    await boot(s);
    const n = String(b.username || "").toLowerCase(), pw = String(b.password || "");
    const u = await byName(s, n), ku = "u:" + n + ":" + (u ? u.tv | 0 : 0) + ":" + ip; // tv changes on admin reset, which clears the lockout
    if ((await Promise.all([locked(s, ku, 8, 9e5), locked(s, "i:" + ip, 40, 9e5), locked(s, "un:" + n, 60, 9e5)])).some(Boolean)) return E("Too many attempts. Try again in 15 minutes.", 429);
    if (n === "admin" && !process.env.ADMIN_PASSWORD && (!u || u.defaultPw)) return E(u ? "The default admin password is disabled for security: set ADMIN_PASSWORD in Netlify environment variables, then redeploy" : "Admin not set up: add ADMIN_PASSWORD in Netlify environment variables, then redeploy", 503);
    if (pw.length < 1 || pw.length > 128 || !(await verify(s, u, pw))) { await Promise.all([hit(s, ku, 9e5), hit(s, "i:" + ip, 9e5), hit(s, "un:" + n, 9e5)]); return E("bad credentials", 401); }
    if (u.disabled) return E("This account is disabled", 403);
    return J({ token: await token(s, u) });
  }
  if (a === "config") return J({ google: process.env.GOOGLE_CLIENT_ID || null }); // public: lets the page show the Google button
  if (a === "google") {
    if (await locked(s, "gi:" + ip, 30, 9e5)) return E("Too many attempts. Try again in 15 minutes.", 429);
    let c; try { c = await googleVerify(b.credential); } catch (e) { await hit(s, "gi:" + ip, 9e5); throw e; }
    const gid = await s.get("g/" + c.sub);
    let u = gid ? await getU(s, gid) : null;
    if (gid && !u) await s.delete("g/" + c.sub); // the linked player was deleted: this Google account may sign up again
    if (u) return u.disabled ? E("This account is disabled", 403) : J({ token: await token(s, u) });
    // First time with this Google account: they pick a username, then land on the skill survey.
    const n = String(b.username ?? "").trim();
    if (!n) return J({ needName: true, email: c.email, suggest: nameFrom(c.email) });
    const pw = String(b.password ?? "");
    if (!NAME.test(n)) return E("invalid");
    if (pw.length < PWMIN || pw.length > 128) return E("badpw");
    if (RESERVED.has(n.toLowerCase())) return E("taken", 409);
    if (await locked(s, "r:" + ip, 40, 36e5)) return E("Too many sign-ups from this network", 429);
    if (await byName(s, n)) return E("taken", 409);
    await hit(s, "r:" + ip, 36e5);
    u = newUser(n); u.g = c.sub; u.ge = c.email; await setPw(u, pw); // they can log in with Google, or with this username and password
    if (!(await createUser(s, u))) return E("taken", 409);
    const w = await s.set("g/" + c.sub, u.id, { onlyIfNew: true });
    if (w && w.modified === false) { // a parallel request linked this Google account first: drop ours, use theirs
      await s.delete("name/" + n.toLowerCase()); await s.delete("u/" + u.id);
      const ex = await getU(s, await s.get("g/" + c.sub));
      return ex && !ex.disabled ? J({ token: await token(s, ex) }) : E("This account is disabled", 403);
    }
    return J({ token: await token(s, u) });
  }
  if (a === "register") {
    if (process.env.GOOGLE_CLIENT_ID) return E("New accounts are created with Google. Tap Continue with Google.", 403);
    const n = String(b.username || ""), pw = String(b.password || "");
    if (!NAME.test(n) || pw.length < PWMIN || pw.length > 128) return E("invalid");
    if (RESERVED.has(n.toLowerCase())) return E("taken", 409);
    // Generous enough for a launch night where everyone signs up on the club's Wi-Fi (one shared IP).
    if (await locked(s, "r:" + ip, 40, 36e5)) return E("Too many sign-ups from this network", 429);
    if (await byName(s, n)) return E("taken", 409);
    await hit(s, "r:" + ip, 36e5);
    const u = newUser(n); await setPw(u, pw);
    if (!(await createUser(s, u))) return E("taken", 409);
    return J({ token: await token(s, u) });
  }

  const me = await auth(s, req);
  if (!me) return E("unauthorized", 401);
  const coach = me.role === "certified_coach" || me.role === "admin", admin = me.role === "admin";
  const CFGW = ["setCfg", "invite", "redeem"].includes(a);
  const ok = async (msg, x) => J({ msg: msg || "", ...x, ...(await snapshot(s, a === "state" ? me : await getU(s, me.id), CFGW ? { ...DEF, ...(await jget(s, "cfg", {})) } : cfg, !!b.full)) });

  if (a === "state") {
    if (!me.la || Date.now() - me.la > 12e4) { const t = Date.now(); await mutU(s, me.id, u => { u.la = t; }); me.la = t; } // last-active, written at most every 2 minutes
    // one-time backfill of the durable roster for coaches whose students predate v7.2
    if (me.role !== "player" && !me.stu) {
      const stu = [...new Set((await jget(s, "bk", [])).filter(x => x.coach === me.id && x.status === "attended").map(x => x.player))];
      await mutU(s, me.id, u => { if (u.stu) return SKIP; u.stu = stu; });
      me.stu = stu;
    }
    // Queued players' polls run matchmaking (a freed court or an expired cross-tier wait is picked up without another
    // join), and any poll finishes scores whose confirmation window has passed. matchmake writes nothing when idle.
    const [q0, m0] = await Promise.all([jget(s, "q", []), jget(s, "m", [])]);
    if (q0.some(x => x.id === me.id && fresh(x)) || m0.some(m => m.status === "playing" && m.cf && Date.now() - m.cf >= CONFIRM))
      if (await matchmake(s, cfg).then(() => true, e => console.warn("poll matchmake", e.message))) // re-read: this poll may have just finished our match
        return J({ msg: "", ...(await snapshot(s, await getU(s, me.id), cfg, !!b.full)) });
    return J({ msg: "", ...(await snapshot(s, me, cfg, !!b.full, { q: q0, m: m0 })) });
  }
  if (a === "players") { // directory search: name contains q; rated players first
    const q = String(b.q || "").toLowerCase().slice(0, 20);
    const rows = (await board(s)).filter(u => !q || u.n.toLowerCase().includes(q)).slice(0, 50);
    return J({ players: rows.map(u => ({ ...u, me: u.id === me.id })) });
  }
  if (a === "profile") {
    const p = await profile(s, String(b.id || ""), String(b.id || "") === me.id);
    return p ? J({ profile: p }) : E("Player not found", 404);
  }
  if (a === "survey") { // self-assessed skill profile: 6 traits, each 1-5; retake every 14 days
    const v = Array.isArray(b.v) ? b.v.map(Number) : [];
    if (v.length !== 6 || !v.every(x => int(x, 1, 5))) return E("Answer every question");
    await mutU(s, me.id, u => {
      if (u.sk && Date.now() - u.sk.t < 14 * 864e5) throw new Bad("You can retake the survey every 14 days");
      u.sk = { v, t: Date.now() };
      // self-assessment only seeds the provisional rating of a player who hasn't played or been coach-rated yet
      if (!rated(u) && !(u.ip > 0) && !u.src) u.pr = r3(2 + v.reduce((a, x) => a + x, 0) / 6 * .5);
    });
    return ok("Skill profile saved");
  }
  if (a === "setAvatar") { // client sends a small square JPEG (about 256 px) as a data URL
    const img = String(b.img || "");
    if (img.length > 120000 || !imgOk(img)) return E("Choose a JPEG, PNG or WebP photo");
    if (await locked(s, "av:" + me.id, 12, 36e5)) return E("Too many photo changes. Try again later.", 429);
    await hit(s, "av:" + me.id, 36e5);
    await s.set("av/" + me.id, img);
    await mutU(s, me.id, u => { u.av = Date.now(); });
    await board(s, true).catch(() => {});
    return ok("Profile picture updated");
  }
  if (a === "removeAvatar") {
    await mutU(s, me.id, u => { if (!u.av) return SKIP; delete u.av; });
    await s.delete("av/" + me.id).catch(() => {});
    await board(s, true).catch(() => {});
    return ok("Profile picture removed");
  }
  if (a === "setCover") { // any signed-in user (player, coach or admin): client sends a wide JPEG (about 1200x480) as a data URL
    const img = String(b.img || "");
    if (img.length > COVMAX || !imgOk(img)) return E("Choose a JPEG, PNG or WebP photo");
    if (await locked(s, "cv:" + me.id, 12, 36e5)) return E("Too many photo changes. Try again later.", 429);
    await hit(s, "cv:" + me.id, 36e5);
    await s.set("cv/" + me.id, img);
    await mutU(s, me.id, u => { u.cv = Date.now(); });
    return ok("Cover photo updated");
  }
  if (a === "removeCover") {
    await mutU(s, me.id, u => { if (!u.cv) return SKIP; delete u.cv; });
    await s.delete("cv/" + me.id).catch(() => {});
    return ok("Cover photo removed");
  }
  if (a === "changePw") {
    const np = String(b.newPw || ""), k = "u:" + me.username.toLowerCase();
    if (await locked(s, k, 8, 9e5)) return E("Too many attempts", 429);
    if (np.length < PWMIN || np.length > 128) return E("Use 8 to 128 characters");
    const had = !!(me.h || me.ph);
    if (had && !(await verify(s, me, String(b.oldPw || "")))) { await hit(s, k, 9e5); return E("wrong password"); }
    let nu; await mutU(s, me.id, async u => { u.tv = (u.tv | 0) + 1; u.defaultPw = false; u.mustChange = false; await setPw(u, np); nu = u; });
    return J({ token: await token(s, nu), ...(await snapshot(s, nu, { ...DEF, ...(await jget(s, "cfg", {})) }, !!b.full)), msg: had ? "Password changed" : "Password set" });
  }

  // ---- Player: check-in, queue, scores
  if (a === "checkin") {
    if (cfg.lat != null && cfg.lng != null) {
      if (typeof b.lat !== "number" || typeof b.lng !== "number") return E("Location required to check in");
      if (dist(cfg.lat, cfg.lng, b.lat, b.lng) > cfg.rad) return E("You are not at the facility");
    }
    await mutU(s, me.id, u => { u.ci = Date.now(); });
    return ok("Checked in for 4 hours");
  }
  if (a === "join") {
    if (Date.now() - me.ci > 4 * 36e5) return E("Check in at the facility first");
    await expire(s, cfg.tz);
    if ((await jget(s, "m", [])).some(m => m.status !== "done" && m.p.includes(me.id))) return E("You are already in a match");
    await mutate(s, "q", [], q => { const f = q.filter(fresh); if (!f.some(x => x.id === me.id)) f.push({ id: me.id, tier: tierOf(me), t: Date.now() }); return f; });
    await matchmake(s, cfg);
    return ok("In the queue");
  }
  if (a === "leave") {
    await mutate(s, "q", [], q => q.filter(x => x.id !== me.id));
    return ok();
  }
  if (a === "score") {
    await expire(s, cfg.tz); // a score whose 15-minute window passed counts before anyone can change it
    let plan = null, st, voided = false;
    await mutate(s, "m", [], async ms => {
      plan = null; voided = false;
      const m = ms.find(x => x.id === b.matchId);
      if (!m || m.status !== "playing" || !m.p.includes(me.id)) throw new Bad("no active match");
      const x = +b.a, y = +b.b;
      if (!validScore(x, y)) throw new Bad("Invalid score: games to 11, 15 or 21, win by 2");
      if (Date.now() - m.start < cfg.minMin * 6e4) throw new Bad(`Match too short (min ${cfg.minMin} min)`);
      m.sub[me.id] = [x, y]; // [teamA score, teamB score]
      const subs = Object.entries(m.sub), v0 = subs[0][1], teamOf = id => (m.p.indexOf(id) < 2 ? 0 : 1);
      if (subs.some(([, v]) => v[0] !== v0[0] || v[1] !== v0[1])) { m.status = "done"; m.void = true; m.end = Date.now(); voided = true; } // scores differ: match cancelled, nothing counts
      else if (subs.length === 4) plan = await planFinish(s, m, x, y, ms, cfg.tz);   // everyone confirmed
      else if (new Set(subs.map(([id]) => teamOf(id))).size === 2) m.cf = m.cf || Date.now(); // both teams agree: clock starts
      st = m.status;
    });
    await applyPlan(s, plan);
    if (st === "done") await matchmake(s, cfg);
    return ok(voided ? "Scores differ: match cancelled, no rating changed. Join the queue again" : st === "done" ? "Score confirmed by all four players"
      : `Score saved. It counts once everyone confirms, or ${CONFIRM / 6e4} min after both teams agree unless someone rejects it.`);
  }
  if (a === "reject") { // any player in the match can reject a submitted score: the match is cancelled and nothing counts
    await expire(s, cfg.tz);
    await mutate(s, "m", [], ms => {
      const m = ms.find(x => x.id === b.matchId);
      if (m && m.status === "done" && m.auto && m.p.includes(me.id)) throw new Bad("Too late: this score already counted after 15 minutes. Ask the other players if it's wrong.");
      if (!m || m.status !== "playing" || !m.p.includes(me.id) || !Object.keys(m.sub).length) throw new Bad("Nothing to reject");
      m.status = "done"; m.void = true; m.end = Date.now(); m.rej = me.id;
    });
    await matchmake(s, cfg);
    return ok("Score rejected: match cancelled, no rating changed");
  }

  // ---- Quests
  if (a === "claim" && String(b.qid || "").startsWith("w")) {
    let gained = 0;
    await mutU(s, me.id, u => {
      const w = weekly(u, cfg.tz);
      if (w.id !== b.qid || w.done || w.n < w.need) throw new Bad("Not available");
      u.done = [...u.done, w.id].slice(-60); const x0 = u.xp; addXp(u, w.xp); gained = u.xp - x0;
    });
    return ok(gained > 0 ? `+${gained} XP` : "Tier ceiling reached: XP is banked until your next badge");
  }
  if (a === "claim") {
    const q = todays(cfg.tz).find(x => x.id === b.qid);
    if (!q) return E("Not available");
    let gained = 0;
    await mutU(s, me.id, u => { if (u.done.includes(q.id)) throw new Bad("Not available"); u.done = [...u.done, q.id].slice(-60); const x0 = u.xp; addXp(u, q.xp); gained = u.xp - x0; });
    return ok(gained > 0 ? `+${gained} XP` : "Tier ceiling reached: XP is banked until your next badge");
  }

  // ---- Bookings, coach tools
  if (a === "book") {
    await mutate(s, "bk", [], async bk => {
      const x = (await jget(s, "ss", [])).find(v => v.id === b.sessionId);
      if (!x || x.status !== "open" || x.ts < Date.now() || x.coach === me.id) throw new Bad("Session not available");
      const live = bk.filter(v => v.sid === x.id && v.status !== "cancelled");
      if (live.some(v => v.player === me.id)) throw new Bad("Already booked");
      if (live.length >= x.cap) throw new Bad("Session is full");
      if (bk.some(v => v.player === me.id && v.status === "booked" && v.ts < x.ts + (x.dur || 60) * 6e4 && x.ts < v.ts + (v.dur || 60) * 6e4)) throw new Bad("You already have a booking at that time");
      bk.push({ id: uid(), sid: x.id, coach: x.coach, player: me.id, kind: x.kind, ts: x.ts, dur: x.dur || 60, made: Date.now(), price: x.price, paid: false, status: "booked" });
      trim(bk, 1000, v => (v.status === "booked" && v.ts > Date.now() - 864e5) || (v.price && v.status !== "cancelled"));
    });
    return ok("Booked. Scan the coach's check-in code when you arrive.");
  }
  if (a === "bkCheckin") { // the player scans the coach's code; same result as the coach tapping Check in (+40 XP)
    const sid = String(b.sid || "");
    if (!ID.test(sid)) return E("invalid");
    const lk = "bc:" + me.id;
    if (await locked(s, lk, 10, 9e5)) return E("Too many wrong codes. Try again later.", 429);
    if (!(await qrOk(s, "bk:" + sid, b.code))) { await hit(s, lk, 9e5); return E("Invalid or expired code. Scan the code on your coach's phone."); }
    let coachId;
    await mutate(s, "bk", [], bk => {
      const k = bk.find(v => v.sid === sid && v.player === me.id && v.status !== "cancelled");
      if (!k) throw new Bad("You have no booking for this session");
      if (k.status === "attended") throw new Bad("You are already checked in");
      if (Date.now() < k.ts - 2 * 36e5 || Date.now() > k.ts + 4 * 36e5) throw new Bad("Check-in opens 2 hours before the session and closes 4 hours after it starts");
      k.status = "attended"; coachId = k.coach;
    });
    const [strk] = await Promise.all([giveXpStreak(s, me.id, 40, cfg.tz), mutU(s, coachId, u => { u.stu = [...new Set([...(u.stu || []), me.id])].slice(-500); })]);
    return ok("✓ Session completed: +40 XP" + (strk > 1 ? ` · New streak: ${strk} days` : ""));
  }
  if (a === "cancel") {
    await mutate(s, "bk", [], bk => {
      const k = bk.find(v => v.id === b.id && v.player === me.id);
      if (!k || k.status !== "booked") throw new Bad("Not found");
      if (k.ts - Date.now() < 2 * 36e5) throw new Bad("Too late to cancel (2 hour policy). Contact your coach.");
      k.status = "cancelled";
    });
    return ok("Booking cancelled");
  }
  if (a === "ref") {
    const r = String(b.ref || "").trim();
    if (!/^[A-Za-z0-9 -]{4,24}$/.test(r)) return E("Enter the reference number from your e-wallet receipt");
    await mutate(s, "bk", [], bk => {
      const k = bk.find(v => v.id === b.id && v.player === me.id && v.status !== "cancelled");
      if (!k) throw new Bad("Not found");
      k.ref = r;
    });
    return ok("Reference sent to your coach");
  }
  if (a === "redeem") {
    if (me.role !== "player") return E("You are already a coach or admin");
    const t = String(b.token || "");
    await mutate(s, "cfg", {}, c => { const inv = c.inv || []; const i = inv.indexOf(t); if (i < 0) throw new Bad("Invalid invite"); inv.splice(i, 1); c.inv = inv; });
    await mutU(s, me.id, u => { u.role = "certified_coach"; }); await coaches(s, true);
    return ok("You are now a Certified Coach");
  }
  // ---- Friends and chat
  if (a === "fAdd") {
    const t = b.id ? await getU(s, String(b.id)) : await byName(s, String(b.name || "").trim());
    if (!t || t.disabled || t.role === "admin") return E("Player not found", 404);
    if (t.id === me.id) return E("That's you");
    if (await locked(s, "fa:" + me.id, 30, 36e5)) return E("Too many requests. Try again later.", 429);
    await hit(s, "fa:" + me.id, 36e5);
    let accept = false;
    await mutF(s, me.id, r => {
      if (r.f.some(x => x.id === t.id)) throw new Bad("You're already friends");
      if (r.o.some(x => x.id === t.id)) throw new Bad("Request already sent");
      if (r.f.length >= FMAX) throw new Bad("Your friend list is full");
      if (r.i.some(x => x.id === t.id)) { accept = true; return SKIP; } // they asked first: this is a yes
      r.o.push({ id: t.id, n: t.username });
    });
    if (accept) { await befriend(s, { id: me.id, n: me.username }, { id: t.id, n: t.username }); return ok(`You and ${t.username} are friends`); }
    await mutF(s, t.id, r => { if (r.f.some(x => x.id === me.id) || r.i.some(x => x.id === me.id)) return SKIP; r.i.push({ id: me.id, n: me.username }); });
    return ok("Friend request sent");
  }
  if (a === "fAccept") {
    const id = String(b.id || ""), q = (await frOf(s, me.id)).i.find(x => x.id === id);
    if (!q) return E("Request not found", 404);
    await befriend(s, { id: me.id, n: me.username }, q);
    return ok(`You and ${q.n} are friends`);
  }
  if (a === "fRemove") { // remove a friend, decline a request, or cancel one you sent
    const id = String(b.id || "");
    if (!ID.test(id)) return E("invalid");
    await unfriend(s, me.id, id); await s.delete(ck(me.id, id));
    return ok("Removed");
  }
  if (a === "fInvite") { // challenge a friend to a game, or invite them to an open play you host or joined: sent as a chat message
    const id = String(b.id || ""), kind = String(b.kind || "");
    if (!(await frOf(s, me.id)).f.some(x => x.id === id)) return E("You can only invite friends", 403);
    let text;
    if (kind === "challenge") text = `🏓 ${me.username} challenges you to a game! Reply here to pick a time and place.`;
    else if (kind === "op") {
      const e = (await jget(s, "op", [])).find(x => x.id === String(b.op || ""));
      if (!e || !OPLIVE(e) || e.ts < Date.now() - 36e5 || !(e.host === me.id || e.pl.some(x => x.id === me.id && !x.left))) return E("Pick an upcoming open play you host or joined");
      text = `🏓 ${me.username} invites you to "${e.title}" at ${e.loc || "the court"}, ${new Date(e.ts).toLocaleString("en-US", { timeZone: cfg.tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. Find it under Open Play.`;
    } else return E("invalid");
    if (await locked(s, "ch:" + me.id, 30, 6e4)) return E("Slow down a little", 429);
    await hit(s, "ch:" + me.id, 6e4);
    const t = Date.now();
    await mutate(s, ck(me.id, id), [], m => { m.push({ f: me.id, t, x: text }); if (m.length > 200) m.splice(0, m.length - 200); });
    await Promise.all([mutF(s, id, r => { const x = r.f.find(z => z.id === me.id); if (!x) return SKIP; x.un = (x.un | 0) + 1; x.lm = t; }),
      mutF(s, me.id, r => { const x = r.f.find(z => z.id === id); if (!x) return SKIP; x.lm = t; })]);
    return ok(kind === "challenge" ? "Challenge sent" : "Invite sent");
  }
  if (a === "chat") return thread(s, me, String(b.id || ""), +b.since || 0);
  if (a === "send") {
    const id = String(b.id || ""), text = String(b.text || "").trim().slice(0, 500);
    if (!text) return E("Type a message first");
    if (!(await frOf(s, me.id)).f.some(x => x.id === id)) return E("You can only message friends", 403);
    if (await locked(s, "ch:" + me.id, 30, 6e4)) return E("Slow down a little", 429);
    await hit(s, "ch:" + me.id, 6e4);
    const t = Date.now();
    await mutate(s, ck(me.id, id), [], m => { m.push({ f: me.id, t, x: text }); if (m.length > 200) m.splice(0, m.length - 200); });
    await Promise.all([mutF(s, id, r => { const x = r.f.find(z => z.id === me.id); if (!x) return SKIP; x.un = (x.un | 0) + 1; x.lm = t; }),
      mutF(s, me.id, r => { const x = r.f.find(z => z.id === id); if (!x) return SKIP; x.lm = t; })]);
    return thread(s, me, id);
  }

  // ---- Group chats: one per club (members only) and one per open play (host and joined players)
  if (a === "gcGet" || a === "gcSend" || a === "gcPin") {
    const kind = String(b.kind || ""), id = String(b.id || "");
    if (!ID.test(id) || (kind !== "club" && kind !== "op" && kind !== "bk")) return E("invalid");
    let title = "", pin = null, owner = "";
    if (kind === "club") {
      const c = (await jget(s, "cl", [])).find(x => x.id === id);
      if (!c) return E("Club not found", 404);
      if (!isMember(c, me.id)) return E("Join the club to use its chat", 403);
      title = c.name; pin = c.pin || null; owner = c.owner;
    } else if (kind === "bk") { // lesson chat: only the coach and the player of that booking
      const k = (await jget(s, "bk", [])).find(x => x.id === id);
      if (!k || (k.coach !== me.id && k.player !== me.id)) return E("Booking not found", 404);
      if (a === "gcSend" && k.status === "cancelled") return E("This booking was cancelled", 403);
      title = "Lesson chat"; owner = k.coach;
    } else {
      const e = (await jget(s, "op", [])).find(x => x.id === id);
      if (!e) return E("Open play not found", 404);
      if (e.host !== me.id && !e.pl.some(x => x.id === me.id && !x.left)) return E("Join the open play to use its chat", 403);
      if (e.club && e.host !== me.id) { // approval-only clubs: the open play's chat is for club members only
        const c = (await jget(s, "cl", [])).find(x => x.id === e.club);
        if (c && c.ap && !isMember(c, me.id)) return E("Join the club to use this open play's chat", 403);
      }
      title = e.title; pin = e.pin || null; owner = e.host;
    }
    const key = `gc/${kind}_${id}`, lk = kind + ":" + id, pinOut = p => p ? { x: p.x, n: p.n, t: p.t } : null;
    if (a === "gcPin") { // host (open play) or owner (club): one pinned note, 200 characters, empty text unpins
      if (me.id !== owner) return E("Only the host can pin a message", 403);
      const text = String(b.text || "").trim().slice(0, PINMAX);
      if (await locked(s, "pn:" + me.id, 10, 6e4)) return E("Slow down a little", 429);
      await hit(s, "pn:" + me.id, 6e4);
      const np = text ? { x: text, n: me.username, t: Date.now() } : null;
      if (kind === "op") await mutOp(s, id, e => { if (np) e.pin = np; else delete e.pin; });
      else await mutate(s, "cl", [], list => { const c = list.find(x => x.id === id); if (!c) throw new Bad("Club not found", 404); if (np) c.pin = np; else delete c.pin; });
      return J({ title, pin: pinOut(np) });
    }
    if (a === "gcGet") {
      const m = await jget(s, key, []), since = +b.since || 0, last = m.at(-1)?.t || 0, lr0 = (await jget(s, "lr/" + me.id, {}))[lk] || 0;
      if (b.seen && last > lr0) await lrSet(s, me.id, lk, last); // the reader has the chat open: everything so far is read
      const lr = b.seen ? Math.max(lr0, last) : lr0, meta = { lr, un: unreadOf(m, me.id, lr), pin: pinOut(pin) };
      if (since && last <= since) return J({ same: true, title, ...meta });
      return J({ title, msgs: m.slice(-100), ...meta });
    }
    const text = String(b.text || "").trim().slice(0, 500);
    let im = null;
    if (b.img) { // photo in an open play chat: a small JPEG/PNG/WebP data URL, kept in its own blob so the message list stays light
      if (kind === "club") return E("Photos can only be sent in open play and lesson chats");
      if (typeof b.img !== "string" || b.img.length > 220000 || !imgOk(b.img)) return E("That photo can't be used. Try another one.");
      im = randomBytes(12).toString("hex");
    }
    if (!text && !im) return E("Type a message first");
    if (await locked(s, "ch:" + me.id, 30, 6e4)) return E("Slow down a little", 429);
    await hit(s, "ch:" + me.id, 6e4);
    let msgs, gone = [];
    if (im) await s.set("ci/" + im, b.img);
    await mutate(s, key, [], m => { gone = []; m.push({ f: me.id, n: me.username, t: Date.now(), x: text, ...(im ? { im } : {}) }); if (m.length > 200) gone = m.splice(0, m.length - 200); msgs = m.slice(-100); });
    await Promise.all(gone.filter(x => x.im).map(x => s.delete("ci/" + x.im).catch(() => {}))); // photos of trimmed messages go too
    await lrSet(s, me.id, lk, msgs.at(-1).t); // writing counts as reading
    return J({ title, msgs, lr: msgs.at(-1).t, un: 0, pin: pinOut(pin) });
  }
  // ---- Clubs
  if (a === "clubs") return J({ clubs: await clubBoard(s, me) });
  if (a.startsWith("club")) {
    const id = String(b.id || "");
    if (a === "clubCreate") {
      const name = cleanName(b.name), f = clubFields(b);
      if (!CLNAME.test(name)) return E("Club names are 3-30 characters: letters, numbers, spaces and . _ & ' -");
      let made;
      await mutate(s, "cl", [], list => {
        if (list.length >= 500) throw new Bad("Too many clubs right now. Try again later.");
        if (list.some(c => c.name.toLowerCase() === name.toLowerCase())) throw new Bad("That club name is taken", 409);
        if (list.filter(c => c.owner === me.id).length >= 5) throw new Bad("You can own up to 5 clubs");
        list.push(made = { id: uid(), name, ...CLDEFAULTS, ...f, rq: [], owner: me.id, on: me.username, made: Date.now(), m: [{ id: me.id, at: Date.now() }] });
      });
      return ok(`Club "${name}" created`, { club: await clubDetail(s, me, made.id) });
    }
    if (!ID.test(id)) return E("invalid");
    if (a === "clubGet") return J({ club: await clubDetail(s, me, id) });
    let msg = "";
    if (a === "clubJoin") {
      await mutate(s, "cl", [], list => {
        const c = list.find(x => x.id === id);
        if (!c) throw new Bad("Club not found", 404);
        if (isMember(c, me.id)) throw new Bad("You're already in this club");
        if (c.ap) {
          c.rq = c.rq || [];
          if (c.rq.some(x => x.id === me.id)) throw new Bad("Your request is already waiting for the owner");
          if (c.rq.length >= 100) throw new Bad("This club has too many waiting requests. Try again later.");
          c.rq.push({ id: me.id, n: me.username, at: Date.now() }); msg = "Request sent. The club owner will review it.";
          return;
        }
        if (c.m.length >= 300) throw new Bad("This club is full");
        c.m.push({ id: me.id, at: Date.now() }); msg = "You joined the club";
      });
    } else if (a === "clubLeave") {
      await mutate(s, "cl", [], list => {
        const c = list.find(x => x.id === id);
        if (c && (c.rq || []).some(x => x.id === me.id)) { c.rq = c.rq.filter(x => x.id !== me.id); msg = "Request cancelled"; return; }
        if (!c || !isMember(c, me.id)) throw new Bad("You're not in this club");
        if (c.owner === me.id) throw new Bad("The owner can't leave. Delete the club instead.");
        c.m = c.m.filter(x => x.id !== me.id); msg = "You left the club";
      });
    } else if (a === "clubKick") {
      const pid = String(b.pid || "");
      await mutate(s, "cl", [], list => {
        const c = list.find(x => x.id === id);
        if (!c) throw new Bad("Club not found", 404);
        if (c.owner !== me.id && !admin) throw new Bad("Only the club owner can do that", 403);
        if (pid === c.owner || !isMember(c, pid)) throw new Bad("That player can't be removed");
        c.m = c.m.filter(x => x.id !== pid);
      });
      msg = "Player removed from the club";
    } else if (a === "clubApprove" || a === "clubDecline") {
      const pid = String(b.pid || "");
      await mutate(s, "cl", [], list => {
        const c = list.find(x => x.id === id);
        if (!c) throw new Bad("Club not found", 404);
        if (c.owner !== me.id && !admin) throw new Bad("Only the club owner can do that", 403);
        const r = (c.rq || []).find(x => x.id === pid);
        if (!r) throw new Bad("That request is gone");
        if (a === "clubApprove" && !isMember(c, pid)) { if (c.m.length >= 300) throw new Bad("This club is full"); c.m.push({ id: pid, at: Date.now() }); }
        c.rq = c.rq.filter(x => x.id !== pid);
      });
      msg = a === "clubApprove" ? "Player approved" : "Request declined";
    } else if (a === "clubUpdate") {
      const f = clubFields(b), sent = b.name !== undefined && b.name !== null, newName = cleanName(b.name);
      if (sent && !CLNAME.test(newName)) return E("Club names are 3-30 characters: letters, numbers, spaces and . _ & ' -");
      let name = newName;
      await mutate(s, "cl", [], list => {
        const c = list.find(x => x.id === id);
        if (!c) throw new Bad("Club not found", 404);
        if (c.owner !== me.id && !admin) throw new Bad("Only the club owner can do that", 403);
        name = sent ? newName : c.name;
        if (list.some(x => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw new Bad("That club name is taken", 409);
        Object.assign(c, f, { name });
        if (!c.ap) c.rq = []; // turning approval off clears the waiting list
      });
      await mutate(s, "op", [], list => { let ch = false; list.forEach(e => { if (e.club === id && e.cn !== name) { e.cn = name; ch = true; } }); return ch ? undefined : SKIP; });
      msg = "Club saved";
    } else if (a === "clubSetCover") {
      const img = String(b.img || "");
      if (img.length > COVMAX || !imgOk(img)) return E("Choose a JPEG, PNG or WebP photo");
      const c0 = (await jget(s, "cl", [])).find(x => x.id === id);
      if (!c0) return E("Club not found", 404);
      if (c0.owner !== me.id && !admin) return E("Only the club owner can do that", 403);
      if (await locked(s, "cvc:" + id, 12, 36e5)) return E("Too many photo changes. Try again later.", 429);
      await hit(s, "cvc:" + id, 36e5);
      await s.set("cvc/" + id, img);
      await mutate(s, "cl", [], list => { const c = list.find(x => x.id === id); if (!c) throw new Bad("Club not found", 404); c.cv = Date.now(); });
      msg = "Club cover photo updated";
    } else if (a === "clubRemoveCover") {
      await mutate(s, "cl", [], list => {
        const c = list.find(x => x.id === id);
        if (!c) throw new Bad("Club not found", 404);
        if (c.owner !== me.id && !admin) throw new Bad("Only the club owner can do that", 403);
        if (!c.cv) return SKIP;
        delete c.cv;
      });
      await s.delete("cvc/" + id).catch(() => {});
      msg = "Club cover photo removed";
    } else if (a === "clubDelete") {
      if ((await jget(s, "op", [])).some(e => e.club === id && OPLIVE(e))) return E("This club still has open plays running. End or cancel them first.");
      await mutate(s, "cl", [], list => {
        const i = list.findIndex(x => x.id === id);
        if (i < 0) throw new Bad("Club not found", 404);
        if (list[i].owner !== me.id && !admin) throw new Bad("Only the club owner can do that", 403);
        list.splice(i, 1);
      });
      await s.delete("gc/club_" + id).catch(() => {});
      await s.delete("cvc/" + id).catch(() => {});
      return ok("Club deleted");
    } else return E("unknown action");
    return ok(msg, { club: await clubDetail(s, me, id) });
  }
  // ---- Hosted open play
  if (a === "opCreate") {
    const title = String(b.title || "").trim().slice(0, 60), loc = String(b.loc || "").trim().slice(0, 100), desc = String(b.desc || "").trim().slice(0, 300), pay = String(b.pay || "").trim().slice(0, 120);
    const ts = +b.ts, dur = Math.min(480, Math.max(30, +b.dur | 0 || 120)), price = Math.round(+b.price * 100) || 0;
    const cap = Math.min(60, Math.max(4, +b.cap | 0 || 16)), courts = Math.min(10, Math.max(1, +b.courts | 0 || 2)), rounds = Math.min(20, Math.max(1, +b.rounds | 0 || 3)), mode = b.mode === "ranked" ? "ranked" : "casual", skill = ["Beginner","Intermediate","Advanced"].includes(b.skill) ? b.skill : "All levels";
    if (title.length < 3 || loc.length < 3) return E("Add a title and the venue name");
    const ven = cleanVen(b.ven); // throws Bad (400) on a broken pin
    if (!(ts > Date.now() - 36e5 && ts < Date.now() + 60 * 864e5)) return E("Pick a start time within the next 60 days");
    if (!(price >= 0 && price <= 1e6)) return E("Check the price");
    if (price && pay.length < 3) return E("Add your GCash or e-wallet details so players know where to pay");
    const club = String(b.club || "");
    if (!ID.test(club)) return E("Pick the club this open play is for");
    const cl = (await jget(s, "cl", [])).find(c => c.id === club);
    if (!cl) return E("Club not found", 404);
    if (!isMember(cl, me.id)) return E("Join this club before hosting an open play for it", 403);
    if (!canHost(cl, me.id)) return E("Only the club owner can host open plays for this club", 403);
    let made;
    const gone = new Set();
    await mutate(s, "op", [], list => {
      for (let i = list.length; i--;) if (!OPLIVE(list[i]) && !OPRECENT(list[i])) gone.add(list.splice(i, 1)[0].id); // housekeeping
      if (list.filter(e => e.host === me.id && OPLIVE(e)).length >= 5) throw new Bad("You already have 5 open plays running");
      if (list.length >= 300) throw new Bad("Too many open plays right now. Try again later.");
      list.push(made = { id: uid(), host: me.id, hn: me.username, club: cl.id, cn: cl.name, mode, skill, title, desc, loc, ven, ts, dur, price, pay, cap, courts, rounds, status: "open", made: Date.now(), seq: 0, fp: !!b.fp, sw: !!b.sw, pairs: [],
        qr: true, pl: [{ id: me.id, n: me.username, j: Date.now(), paid: true, ci: 0 }], g: [] }); // the host is listed as a player (doesn't pay) but is not in the games until checked in
    });
    await Promise.all([...gone].map(i => s.delete("gc/op_" + i).catch(() => {})));
    return ok("Open play published", { od: opDetail(made, me) });
  }
  if (a.startsWith("op") && a !== "opCreate") {
    const id = String(b.id || ""), pid = String(b.pid || "");
    if (!ID.test(id)) return E("invalid");
    const hostOnly = e => { if (e.host !== me.id) throw new Bad("Only the host can do that", 403); };
    let msg = "", e, rate = null, skipped = 0, logIt = false;
    if (a === "opGet") {
      e = (await jget(s, "op", [])).find(x => x.id === id);
      if (!e) return E("Open play not found", 404);
      return J({ od: opDetail(e, me) });
    }
    if (a === "opCode") { // the host's phone polls this; the code changes every minute
      const e0 = (await jget(s, "op", [])).find(x => x.id === id);
      if (!e0) return E("Open play not found", 404);
      if (e0.host !== me.id) return E("Only the host can show the check-in code", 403);
      if (e0.status !== "open" && e0.status !== "live") return E("This open play is closed");
      return J({ code: await qrAt(s, "op:" + id, qrNow()) });
    }
    if (a === "opCheckin") {
      const lk = "oc:" + me.id;
      if (await locked(s, lk, 10, 9e5)) return E("Too many wrong codes. Try again later.", 429);
      if (!(await qrOk(s, "op:" + id, b.code))) { await hit(s, lk, 9e5); return E("Invalid or expired code. Scan the code on the host's phone."); }
      e = await mutOp(s, id, e => {
        if (e.status !== "open" && e.status !== "live") throw new Bad("This open play is closed");
        const x = e.pl.find(z => z.id === me.id && !z.left);
        if (!x) throw new Bad("Join this open play first, then scan the code");
        if (Date.now() < e.ts - 2 * 36e5) throw new Bad("Check-in opens 2 hours before the start");
        if (!x.ci) x.ci = Date.now();
        x.out = 0; // scanning again after checking out brings you back
        opSync(e);
      });
      const mine = e.pl.find(z => z.id === me.id);
      return ok(mine && mine.paid ? "Checked in. You're in the games." : "Checked in. Pay the host to get into the games.", { od: opDetail(e, me) });
    }
    if (a === "opJoin") {
      e = await mutOp(s, id, async e => {
        if (!OPLIVE(e)) throw new Bad("This open play is closed");
        if (e.club && e.host !== me.id) {
          const c = (await jget(s, "cl", [])).find(x => x.id === e.club);
          if (c && c.ap && !isMember(c, me.id)) throw new Bad("This club approves its members. Join the club first, then you can join its open plays.", 403);
        }
        if (e.pl.some(x => x.id === me.id && !x.left)) throw new Bad("You already joined");
        if (e.pl.filter(x => !x.left).length >= e.cap) throw new Bad("This open play is full");
        const old = e.pl.find(x => x.id === me.id && x.left && x.cr);
        if (old) { old.left = false; old.cr = false; old.ci = 0; old.out = 0; } // paid before leaving and not refunded: the payment still counts
        else {
          e.pl = e.pl.filter(x => x.id !== me.id); // otherwise rejoining starts fresh
          e.pl.push({ id: me.id, n: me.username, j: Date.now(), paid: !e.price });
        }
        opSync(e);
      });
      const back = e.pl.find(x => x.id === me.id);
      msg = back && back.paid && e.price ? "Welcome back. Your payment still counts." : e.price ? "Joined. Pay the host and send your reference number to get into the games." : "Joined";
    } else if (a === "opLeave") {
      e = await mutOp(s, id, e => {
        const x = e.pl.find(z => z.id === me.id && !z.left);
        if (!x) throw new Bad("You haven't joined");
        if (e.host === me.id) throw new Bad("The host can't leave. Cancel or end the open play instead.");
        dropOpen(e, me.id);
        if (x.paid && e.price) { x.left = true; x.cr = true; x.ci = 0; x.out = 0; } // keep the payment on record until the host refunds it
        else if (e.g.some(g => g.p.includes(me.id))) x.left = true; else e.pl = e.pl.filter(z => z !== x); // keep the name if they already played
        opSync(e);
      });
      msg = "You left this open play. Ask the host about a refund if you already paid. If you rejoin before then, your payment still counts.";
    } else if (a === "opRefund") { // host: gave the money back to a player who left, so the payment credit is cleared
      e = await mutOp(s, id, e => {
        hostOnly(e);
        const x = e.pl.find(z => z.id === pid && z.left && z.cr);
        if (!x) throw new Bad("Nothing to refund");
        x.cr = false; x.paid = false; x.ref = "";
        if (!e.g.some(g => g.p.includes(x.id))) e.pl = e.pl.filter(z => z !== x);
        msg = `${x.n} refunded`;
      });
    } else if (a === "opRef") {
      const r = String(b.ref || "").trim();
      if (!/^[A-Za-z0-9 -]{4,24}$/.test(r)) return E("Enter the reference number from your e-wallet receipt");
      e = await mutOp(s, id, e => { const x = e.pl.find(z => z.id === me.id && !z.left); if (!x) throw new Bad("Join first"); x.ref = r; });
      msg = "Reference sent to the host";
    } else if (a === "opPaid") {
      e = await mutOp(s, id, e => {
        hostOnly(e);
        const x = e.pl.find(z => z.id === pid && !z.left);
        if (!x || x.id === e.host) throw new Bad("Player not found");
        x.paid = !x.paid; msg = x.paid ? `${x.n} is in` : `${x.n} marked unpaid`;
        if (!x.paid) dropOpen(e, x.id);
        opSync(e);
      });
    } else if (a === "opArrive") { // host fallback when a phone can't scan
      e = await mutOp(s, id, e => {
        hostOnly(e);
        const x = e.pl.find(z => z.id === pid && !z.left);
        if (!x || x.id === e.host) throw new Bad("Player not found");
        x.ci = x.ci || Date.now(); x.out = 0; msg = `${x.n} checked in`;
        opSync(e);
      });
    } else if (a === "opPair" || a === "opUnpair") { // host: fixed partners (only when the session allows it)
      e = await mutOp(s, id, e => {
        hostOnly(e);
        if (e.status !== "open" && e.status !== "live") throw new Bad("This open play is over");
        if (!e.fp) throw new Bad("Fixed pairing is not allowed in this open play", 400);
        e.pairs = e.pairs || [];
        if (a === "opUnpair") { e.pairs = e.pairs.filter(q => !q.includes(pid)); msg = "Pair removed. New games use random partners."; }
        else {
          const x = String(b.a || ""), y = String(b.b || ""), ok = z => e.pl.some(q => q.id === z && !q.left);
          if (x === y || !ok(x) || !ok(y)) throw new Bad("Pick two different players from this open play");
          if (e.pairs.some(q => q.includes(x) || q.includes(y))) throw new Bad("One of them is already in a pair. Remove that pair first.");
          e.pairs.push([x, y]); msg = "Pair saved. It applies to games added to the queue from now on.";
        }
        opSync(e);
      });
    } else if (a === "opSwap") { // host: change a player in a waiting game (only when the session allows it)
      e = await mutOp(s, id, e => {
        hostOnly(e);
        if (e.status !== "live") throw new Bad("Swapping works once the games have started");
        if (!e.sw) throw new Bad("Player swapping is not allowed in this open play");
        const g = e.g.find(z => z.id === String(b.gid || "")), o = String(b.out || ""), n = String(b.in || "");
        if (!g || g.st !== "q") throw new Bad("Only waiting games can be changed");
        if (!g.p.includes(o) || g.p.includes(n) || o === n) throw new Bad("Pick one player in this game and a different player");
        if (!inPlay(e).some(x => x.id === n)) throw new Bad("That player is not checked in and paid");
        if (e.g.some(z => z.st === "p" && z.p.includes(n))) throw new Bad("That player is on a court right now");
        const h = e.g.find(z => z !== g && z.st === "q" && z.p.includes(n)); // also in another waiting game: trade places
        g.p[g.p.indexOf(o)] = n; if (h) h.p[h.p.indexOf(n)] = o;
        msg = "Players swapped";
        opSync(e);
      });
    } else if (a === "opHostIn" || a === "opHostOut") { // the host checks themselves in to play, or out again
      e = await mutOp(s, id, e => {
        hostOnly(e);
        if (e.status !== "open" && e.status !== "live") throw new Bad("This open play is over");
        const x = e.pl.find(z => z.id === e.host);
        if (!x) throw new Bad("Host not found");
        if (a === "opHostIn") { x.ci = x.ci || Date.now(); x.out = 0; msg = "You're checked in and will be scheduled to play"; }
        else {
          if (e.g.some(g => g.st === "p" && g.p.includes(x.id))) throw new Bad("You are on a court. Finish or remove that game first.");
          dropOpen(e, x.id); x.ci = 0; x.out = Date.now(); msg = "You're checked out. You won't be in any more games.";
        }
        opSync(e);
      });
    } else if (a === "opCheckout") { // host: a player is done for the day. Their waiting games go, finished games stay, scanning again brings them back
      e = await mutOp(s, id, e => {
        hostOnly(e);
        if (e.status !== "open" && e.status !== "live") throw new Bad("This open play is over");
        const x = e.pl.find(z => z.id === pid && !z.left);
        if (!x || x.id === e.host) throw new Bad("Player not found");
        if (!e.qr) throw new Bad("Use Remove for this open play");
        if (!x.ci) throw new Bad(`${x.n} isn't checked in`);
        if (e.g.some(g => g.st === "p" && g.p.includes(x.id))) throw new Bad(`${x.n} is on a court. Finish or remove that game first.`);
        dropOpen(e, x.id); x.ci = 0; x.out = Date.now(); opSync(e);
        msg = `${x.n} checked out`;
      });
    } else if (a === "opKick") {
      e = await mutOp(s, id, e => {
        hostOnly(e);
        const x = e.pl.find(z => z.id === pid && !z.left);
        if (!x || x.id === e.host) throw new Bad("Player not found");
        dropOpen(e, x.id);
        if (e.g.some(g => g.p.includes(x.id))) x.left = true; else e.pl = e.pl.filter(z => z !== x);
        opSync(e); msg = `${x.n} removed`;
      });
    } else if (a === "opStart") {
      e = await mutOp(s, id, e => {
        hostOnly(e);
        if (e.status !== "open") throw new Bad("Already started");
        if (inPlay(e).length < (e.mode === "ranked" ? 8 : 4)) throw new Bad(e.mode === "ranked" ? "A ranked open play needs at least 8 players who paid and checked in" : "You need at least 4 players who paid and checked in to start");
        e.status = "live"; e.started = Date.now(); opSync(e);
      });
      msg = "Games started. The queue is set.";
    } else if (a === "opShuffle") {
      e = await mutOp(s, id, e => {
        hostOnly(e);
        if (e.status !== "live") throw new Bad("Start the games first");
        e.g = e.g.filter(g => g.st !== "q"); opSync(e);
      });
      msg = "Queue re-randomized";
    } else if (a === "opScore") {
      const x = +b.a, y = +b.b;
      if (!int(x, 0, 40) || !int(y, 0, 40) || x === y) return E("Enter a final score with a winner");
      e = await mutOp(s, id, e => {
        const g = e.g.find(z => z.id === String(b.gid || ""));
        if (e.status !== "live" || !g) throw new Bad("Game not found");
        hostOnly(e);
        if (g.st === "q") throw new Bad("This game hasn't started");
        if (e.mode === "ranked" && !validScore(x, y)) throw new Bad("Ranked games count toward ratings: use a valid final score (to 11, 15 or 21, win by 2)");
        g.sa = x; g.sb = y; if (g.st === "p") { g.st = "d"; g.t1 = Date.now(); }
        // ranked: if the host plays in this game, the other team must confirm; otherwise the host's entry is final
        if (e.mode === "ranked") { const i = g.p.indexOf(me.id); g.cf = i < 0 ? [1, 1] : [i < 2 ? 1 : 0, i < 2 ? 0 : 1]; }
        opSync(e);
      });
      msg = "Score saved";
    } else if (a === "opConfirm") { // ranked: a player on the team that did not enter the score confirms it
      e = await mutOp(s, id, e => {
        const g = e.g.find(z => z.id === String(b.gid || ""));
        if (e.status !== "live" || !g || g.st !== "d") throw new Bad("Game not found");
        const i = g.p.indexOf(me.id);
        if (e.mode !== "ranked" || !g.cf) throw new Bad("This game needs no confirmation");
        if (i < 0) throw new Bad("Only players in this game can confirm", 403);
        if (g.cf[i < 2 ? 0 : 1]) throw new Bad("Your team already confirmed this score");
        g.cf[i < 2 ? 0 : 1] = 1;
      });
      msg = "Score confirmed";
    } else if (a === "opVoid") { // host: throw a game back into the queue (wrong players, injury, ...)
      e = await mutOp(s, id, e => {
        hostOnly(e);
        const g = e.g.find(z => z.id === String(b.gid || ""));
        if (!g || g.st !== "p") throw new Bad("Game not found");
        e.g = e.g.filter(z => z !== g); opSync(e);
      });
      msg = "Game removed. The queue was topped up.";
    } else if (a === "opCourt") { // host: one more court; the next queued game goes on it straight away
      e = await mutOp(s, id, e => {
        hostOnly(e);
        if (e.status !== "open" && e.status !== "live") throw new Bad("This open play is over");
        if (e.courts >= 10) throw new Bad("10 courts is the maximum");
        e.courts++; opSync(e);
      });
      msg = `Court ${e.courts} added`;
    } else if (a === "opMore") { // host: one more game for every paid player
      e = await mutOp(s, id, e => {
        hostOnly(e);
        if (e.status !== "open" && e.status !== "live") throw new Bad("This open play is over");
        if (e.rounds >= 20) throw new Bad("20 games each is the maximum");
        e.rounds++; opSync(e);
      });
      msg = `Everyone now plays ${e.rounds} games`;
    } else if (a === "opEnd") {
      e = await mutOp(s, id, e => {
        hostOnly(e);
        if (e.status !== "live") throw new Bad("Nothing to end");
        if (e.mode === "ranked" && !e.applied) { const n = e.g.filter(g => g.st === "p").length; if (n) throw new Bad(`${n} game${n === 1 ? " is" : "s are"} still on court. Enter the score or remove ${n === 1 ? "it" : "them"} first, or it won't count toward ratings.`); }
        e.g = e.g.filter(g => g.st === "d"); e.status = "ended"; e.ended = Date.now();
        const uc = e.mode === "ranked" && !e.applied ? e.g.filter(g => g.cf && !(g.cf[0] && g.cf[1])).length : 0; skipped = uc;
        rate = e.mode === "ranked" && !e.applied ? e.g.filter(g => !g.cf || (g.cf[0] && g.cf[1])).sort((m, n) => (m.t1 || 0) - (n.t1 || 0)).map(g => ({ id: g.id, p: g.p.slice(), sa: g.sa, sb: g.sb })) : null; // ratings are applied exactly once
        if (rate) e.applied = true;
        if (!e.logged) { e.logged = true; logIt = true; }
      });
      if (logIt) await logGames(s, e);
      msg = "Open play ended. Final ranking saved.";
      if (rate) { // ranked: every game now counts toward the club rating, in the order it was played
        for (const g of rate) {
          try {
            const pl = await planFinish(s, { id: g.id, p: g.p, o: id, sub: {}, status: "playing" }, g.sa, g.sb, [], cfg.tz);
            await applyPlan(s, pl, true);
            if (pl && pl.fl) await mutate(s, "fl", [], fl => { fl.push({ id: g.id, p: g.p.slice(), t: Date.now() }); fl.splice(0, Math.max(0, fl.length - 50)); }).catch(() => {});
          } catch (x) { console.error("ranked open play", x); }
        }
        await board(s, true).catch(() => {});
        msg = `Open play ended. ${rate.length} ranked game${rate.length === 1 ? "" : "s"} counted toward ratings.` + (skipped ? ` ${skipped} not counted (the other team never confirmed).` : "");
      }
    } else if (a === "opCancel") {
      e = await mutOp(s, id, e => {
        hostOnly(e);
        if (e.status !== "open") throw new Bad("Already started: end it instead");
        e.status = "cancelled"; e.ended = Date.now();
      });
      msg = "Open play cancelled. Refund anyone who paid.";
    } else return E("unknown action");
    return ok(msg, { od: opDetail(e, me) });
  }

  if (["attend", "assess", "assign", "approve", "addSession", "cancelSession", "paid", "setPay", "sesCode"].includes(a)) {
    if (!coach) return E("forbidden", 403);
    if (a === "setPay") {
      const text = String(b.text || "").trim().slice(0, 120);
      await mutU(s, me.id, u => { u.pay = text; }); await coaches(s, true);
      return ok("Payment details saved");
    }
    if (a === "sesCode") { // the coach's phone shows this for one of their own sessions
      const x = (await jget(s, "ss", [])).find(v => v.id === String(b.sid || "") && v.coach === me.id && v.status === "open");
      if (!x) return E("Session not found", 404);
      return J({ code: await qrAt(s, "bk:" + x.id, qrNow()) });
    }
    if (a === "addSession") {
      const ts = +b.ts, price = Math.round(+b.price * 100), kind = b.kind === "clinic" ? "clinic" : "lesson", title = String(b.title || "").trim().slice(0, 60);
      const loc = String(b.loc || "").trim().slice(0, 100);
      if (loc.length < 3) return E("Add the venue name so players know where to go");
      const ven = cleanVen(b.ven); // throws Bad (400) on a broken pin
      const cap = kind === "lesson" ? 1 : Math.min(24, Math.max(2, +b.cap | 0 || 8)), dur = Math.min(240, Math.max(30, +b.dur | 0 || (kind === "clinic" ? 90 : 60)));
      if (!title || !(ts > Date.now() && ts < Date.now() + 90 * 864e5) || !(price >= 0 && price <= 10000000)) return E("Check title, a future time (within 90 days) and price");
      await mutate(s, "ss", [], ss => {
        if (ss.some(v => v.coach === me.id && v.status === "open" && v.ts < ts + dur * 6e4 && ts < v.ts + (v.dur || 60) * 6e4)) throw new Bad("That overlaps another of your sessions");
        if (ss.filter(v => v.coach === me.id && v.status === "open" && v.ts > Date.now()).length >= 60) throw new Bad("Too many open sessions");
        ss.push({ id: uid(), coach: me.id, kind, ts, title, loc, ven, price, cap, dur, status: "open" });
        trim(ss, 500, v => v.status === "open" && v.ts > Date.now() - 864e5);
      });
      return ok("Session published");
    }
    if (a === "cancelSession") {
      let sid;
      await mutate(s, "ss", [], ss => { const x = ss.find(v => v.id === b.sid && v.coach === me.id && v.status === "open"); if (!x) throw new Bad("Not found"); x.status = "cancelled"; sid = x.id; });
      await mutate(s, "bk", [], bk => { let ch = false; bk.forEach(v => { if (v.sid === sid && v.status === "booked") { v.status = "cancelled"; ch = true; } }); return ch ? undefined : SKIP; });
      return ok("Session cancelled, bookings released");
    }
    if (a === "paid") {
      let paid;
      await mutate(s, "bk", [], bk => { const k = bk.find(v => v.id === b.id && v.coach === me.id && v.status !== "cancelled"); if (!k) throw new Bad("Not found"); k.paid = !k.paid; paid = k.paid; });
      return ok(paid ? "Marked paid" : "Marked unpaid");
    }
    if (a === "attend") {
      let pid;
      await mutate(s, "bk", [], bk => {
        const k = bk.find(x => x.id === String(b.id || "").trim() && x.coach === me.id);
        if (!k || k.status !== "booked") throw new Bad("Booking not found");
        if (k.sid && (Date.now() < k.ts - 2 * 36e5 || Date.now() > k.ts + 4 * 36e5)) throw new Bad("Check-in opens 2 hours before the session and closes 4 hours after it starts");
        k.status = "attended"; pid = k.player;
      });
      const [strk2] = await Promise.all([giveXpStreak(s, pid, 40, cfg.tz), mutU(s, me.id, u => { u.stu = [...new Set([...(u.stu || []), pid])].slice(-500); })]);
      return ok("Checked in: +40 XP to player" + (strk2 > 1 ? ` (${strk2}-day streak)` : ""));
    }
    if (a === "approve") {
      let h2;
      await mutate(s, "hw", [], hw => { // only the assigning coach can sign off
        const h = hw.find(x => x.id === b.id && x.coach === me.id);
        if (!h || h.status !== "open" || h.student === me.id) throw new Bad("Not found");
        h.status = "done"; h2 = { st: h.student, xp: h.xp };
      });
      await giveXp(s, h2.st, h2.xp);
      return ok(`Approved: +${h2.xp} XP`);
    }
    // assess / assign: student must have an attended session with this coach
    const pid = String(b.playerId || ""), bk = await jget(s, "bk", []);
    if (pid === me.id || !((me.stu || []).includes(pid) || bk.some(x => x.coach === me.id && x.player === pid && x.status === "attended"))) return E("Student has no attended session with you");
    if (a === "assess") {
      const d = BADGES[b.badge];
      if (!d) return E("Unknown badge");
      if (b.pass !== true) return ok("Marked: not yet");
      let name;
      await mutU(s, pid, u => {
        if (u.badges.includes(b.badge)) throw new Bad("Already earned");
        if (d.tier !== tierOf(u) + 1) throw new Bad("Earn the previous tier badge first");
        u.badges.push(b.badge); const bank = u.bank | 0; u.bank = 0; addXp(u, 100 + bank); name = u.username;
      });
      return ok(`${d.n} awarded to ${name}`);
    }
    if (a === "assign") {
      const t = String(b.title || "").trim().slice(0, 120), xp = Math.min(100, Math.max(10, +b.xp | 0 || 30));
      if (!t) return E("Title required");
      await mutate(s, "hw", [], hw => { hw.push({ id: uid(), coach: me.id, student: pid, title: t, xp, status: "open", ts: Date.now() }); trim(hw, 1000, v => v.status === "open"); });
      return ok("Homework assigned");
    }
  }

  // ---- Admin
  if (!admin) return E("forbidden", 403);
  if (a === "setRole") {
    const id = String(b.id || "");
    if (!ROLE.includes(b.role) || (id === me.id && b.role !== "admin")) return E("invalid");
    await mutU(s, id, u => { u.role = b.role; }); await coaches(s, true);
    return ok("Role updated");
  }
  if (a === "resetElo") { // reset rating: the player goes back to NR and re-initializes
    await mutU(s, String(b.id || ""), u => { delete u.r; delete u.f; delete u.src; u.pr = NR_ASSUME; u.ip = 0; });
    await board(s, true);
    return ok("Rating reset: player is NR again");
  }
  if (a === "setDisabled") {
    const id = String(b.id || "");
    if (id === me.id) return E("invalid");
    await mutU(s, id, u => { u.disabled = !!b.disabled; }); await Promise.all([coaches(s, true), board(s, true)]);
    await mutate(s, "q", [], q => q.filter(x => x.id !== id));
    return ok(b.disabled ? "User disabled" : "User enabled");
  }
  if (a === "resetPw") { // forgotten password: admin issues a temporary one, all of that user's sessions end
    const id = String(b.id || "");
    if (id === me.id) return E("Use Change password on the Me tab for your own account");
    const tmp = randomBytes(6).toString("base64url").replace(/[-_]/g, "x");
    let name; await mutU(s, id, async u => { u.tv = (u.tv | 0) + 1; u.mustChange = true; await setPw(u, tmp); name = u.username; });
    await s.delete(rk("u:" + name.toLowerCase())); // clear any login lockout for that name
    await s.delete(rk("un:" + name.toLowerCase()));
    return ok(`Temporary password for ${name}: ${tmp}`);
  }
  if (a === "setCfg") {
    const courts = String(b.courts || "").split(",").map(x => x.trim().slice(0, 20)).filter(Boolean).slice(0, 30);
    let tz = cfg.tz;
    try { if (b.tz) { new Intl.DateTimeFormat("en-CA", { timeZone: String(b.tz) }); tz = String(b.tz); } } catch { return E("Unknown time zone"); }
    const lat = b.lat === "" || b.lat == null ? null : +b.lat, lng = b.lng === "" || b.lng == null ? null : +b.lng;
    if ((lat == null) !== (lng == null) || (lat != null && !(Math.abs(lat) <= 90 && Math.abs(lng) <= 180))) return E("Enter both latitude (-90 to 90) and longitude (-180 to 180), or leave both blank");
    await mutate(s, "cfg", {}, c => { // field-level merge: never clobbers invite tokens issued meanwhile
      Object.assign(c, { tz, courts: [...new Set(courts.length ? courts : cfg.courts)], lat, lng, rad: Math.min(2000, Math.max(30, +b.rad || 150)), minMin: Math.min(30, Math.max(0, +b.minMin || 0)) });
    });
    return ok("Settings saved");
  }
  if (a === "invite") {
    const t = randomBytes(6).toString("hex");
    await mutate(s, "cfg", {}, c => { c.inv = [...(c.inv || []), t].slice(-20); });
    return ok("Invite: " + t);
  }
  return E("unknown action");
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) { if (e instanceof Bad) return E(e.message, e.st); console.error(e); return E("Server error", 500); }
};

export const config = { path: "/api" };
