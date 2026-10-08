// UI smoke test: the real public/index.html in jsdom, with fetch wired straight into the API handler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { fresh, HOUR } from "./helpers/harness.mjs";

const HTML = readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace("function hideLoader(min=700)", "function hideLoader(min=0)").replace("e.remove();r()},200)", "e.remove();r()},0)"); // tests skip the loader's minimum display time, which keeps the app busy and swallows early clicks
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
let lastW;
async function until(fn, what, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick(10)) if (fn()) { // the app ignores clicks while it is busy (login loader still fading), so wait for idle
    for (let i = 0; i < 150 && (() => { try { return lastW?.eval("busy"); } catch { return false; } })(); i++) await tick(10);
    return;
  }
  throw new Error("timed out waiting for " + what);
}

async function openApp(c, { token, confirmAnswer = true, failFetch = false, html = HTML, url = "https://club.test/" } = {}) {
  const calls = [];
  const dom = new JSDOM(html, {
    url, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      if (token) w.localStorage.setItem("pt", token);
      w.confirm = () => w.__confirm;
      w.__confirm = confirmAnswer;
      w.fetch = async (_url, o) => {
        const body = JSON.parse(o.body); calls.push(body.action);
        if (failFetch) throw new TypeError("Failed to fetch");
        const r = await c.call(body.action, body, (o.headers.authorization || "").replace("Bearer ", ""), "198.51.100.9");
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
      };
    },
  });
  const w = lastW = dom.window, $ = s => w.document.querySelector(s);
  const click = sel => { const e = typeof sel === "string" ? $(sel) : sel; assert.ok(e, "missing " + sel); e.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); };
  const text = () => w.document.getElementById("app").textContent;
  return { w, $, click, text, calls, close: () => w.close() };
}

test("sign up, take the survey, and land on the Play tab", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const app = await openApp(c);
  app.click("[data-a=mode]");
  app.$("#u").value = "uitester"; app.$("#p").value = "secret123";
  app.click("[data-a=auth]");
  await until(() => app.text().includes("Skill survey"), "survey");
  app.click("[data-a=sv]");
  await until(() => app.text().includes("Open play"), "play tab");
  assert.ok(app.$('nav.tabs [aria-current="page"]'), "current tab is announced");
  assert.ok([...app.w.document.querySelectorAll("input[placeholder]")].every(i => i.getAttribute("aria-label")), "inputs are labelled");
  app.close();
});

test("a double tap sends one request, not two", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const t = await c.player("doubletap", "198.51.100.1");
  const app = await openApp(c, { token: t });
  await until(() => app.text().includes("Open play"), "play tab");
  app.click("[data-a=tab][data-v=quests]");
  await tick(100); // let the tab finish drawing so the button we click is still attached
  app.click("[data-a=claim]"); app.click("[data-a=claim]");
  await until(() => app.text().includes("✓ Complete"), "claim result");
  assert.equal(app.calls.filter(a => a === "claim").length, 1);
  assert.ok(!app.$(".toast")?.textContent.startsWith("!"), "no error toast from a second claim");
  app.close();
});

test("coach: cancelling a booked session asks first; one-tap student check-in works", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const at = (await c.ok("login", { username: "admin", password: "x-admin-pw" })).token;
  const inv = (await c.ok("invite", {}, at)).msg.replace("Invite: ", "");
  const ct = await c.register("coachui", "198.51.100.2"); await c.ok("redeem", { token: inv }, ct);
  await c.ok("addSession", { kind: "clinic", ts: Date.now() + HOUR, title: "Drops", loc: "Test Courts", price: 500, cap: 4, dur: 60 }, ct);
  const p = await c.player("studentui", "198.51.100.3");
  await c.ok("book", { sessionId: (await c.ok("state", {}, p)).sessions[0].id }, p);

  const app = await openApp(c, { token: ct, confirmAnswer: false });
  await until(() => app.$("[data-v=coach]"), "coach tab");
  app.click("[data-a=tab][data-v=coach]");
  app.click("[data-a=cancelSession]");
  await tick(50);
  assert.equal(app.calls.filter(a => a === "cancelSession").length, 0, "declined confirm sends nothing");

  app.click("[data-a=attend][data-v]");
  await until(() => app.$(".toast")?.textContent.includes("Checked in"), "check-in toast");
  assert.equal((await c.ok("state", {}, p)).me.xp, 40);
  app.close();
});

test("network failure shows a human message instead of 'Failed to fetch'", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const app = await openApp(c, { failFetch: true });
  app.$("#u").value = "someone"; app.$("#p").value = "secret123";
  app.click("[data-a=auth]");
  await until(() => app.$(".toast"), "toast");
  assert.match(app.$(".toast").textContent, /reach the server|offline/);
  app.close();
});

test("host's open play screen draws the check-in QR locally; a player with that code is checked in", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const h = await c.player("hostui", "198.51.100.4");
  const club = (await c.ok("clubCreate", { name: "UI Club" }, h)).club.id;
  const od = (await c.ok("opCreate", { club, title: "UI night", loc: "Riverside Courts", ts: Date.now() + HOUR, price: 0, cap: 12, courts: 1, rounds: 1 }, h)).od;
  // jsdom doesn't fetch script files, so inline the vendored library in place of its <script src>
  const lib = readFileSync(new URL("../public/vendor/qrcode.min.js", import.meta.url), "utf8");
  const html = HTML.replace("</head>", () => `<script>${lib}</script></head>`); // the page loads the QR library on demand; jsdom gets it inline
  assert.notEqual(html, HTML, "page loads the vendored QR library");
  assert.ok(!/cdnjs|unpkg|jsdelivr/.test(HTML), "no third-party script hosts");
  assert.ok(!/Front-desk|front desk/.test(HTML), "the old admin front-desk screen is gone");
  const app = await openApp(c, { token: h, html });
  await until(() => app.$("[data-a=tab][data-v=open]"), "open play tab");
  app.click("[data-a=tab][data-v=open]");
  await until(() => app.$("[data-a=ov]"), "open play row");
  app.click("[data-a=ov]");
  await until(() => app.$("[data-a=qrOn]"), "show code button");
  app.click("[data-a=qrOn]");
  await until(() => app.$("#qrbox")?.firstChild, "QR drawn");
  const code = app.$("#qrbox").parentElement.querySelector(".big").textContent.trim();
  assert.match(code, /^[A-Z0-9]{8}$/);
  const p = await c.player("scanui", "198.51.100.5");
  await c.ok("opJoin", { id: od.id }, p);
  assert.equal((await c.call("opCheckin", { id: od.id, code: "WRONG123" }, p)).status, 400);
  await c.ok("opCheckin", { id: od.id, code }, p);
  assert.equal((await c.ok("opGet", { id: od.id }, p)).od.pl.find(x => x.me).here, true);
  app.close();
});

test("first-time player sees the getting-started guide with the next step highlighted", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const app = await openApp(c);
  app.click("[data-a=mode]");
  app.$("#u").value = "rookie"; app.$("#p").value = "secret123";
  app.click("[data-a=auth]");
  await until(() => app.$("[data-a=sv]"), "survey");
  app.click("[data-a=sv]");
  await until(() => app.text().includes("Getting started"), "guide");
  assert.match(app.$(".steps li.now").textContent, /Join an open play/);
  assert.match(app.text(), /NR means not rated yet/);
  app.click("[data-a=hideGuide]");
  await until(() => !app.text().includes("Getting started"), "guide hidden");
  app.close();
});

test("scores are entered from your own team's point of view, whichever side you're on", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const ts = [];
  for (const n of ["lefty", "lefta", "righty", "righta"]) { ts.push(await c.player(n, "198.51.100." + (20 + ts.length))); await c.ok("join", {}, ts.at(-1)); }
  const sides = await Promise.all(ts.map(async t => (await c.ok("state", {}, t)).match.side));
  const rightTok = ts[sides.indexOf(1)], leftTok = ts[sides.indexOf(0)];
  const { advance, MIN } = await import("./helpers/harness.mjs"); advance(6 * MIN);
  const app = await openApp(c, { token: rightTok });
  await until(() => app.$("#sa"), "score inputs");
  app.$("#sa").value = "11"; app.$("#sb").value = "6"; // "we won 11-6" typed by a right-side player
  app.click("[data-a=score]");
  await until(() => app.text().includes("Done on your side. Your team won 11-6"), "own-perspective confirmation");
  assert.match(app.text(), /Entered the score/);
  const left = await c.ok("state", {}, leftTok);
  assert.deepEqual(left.match.agreed, [6, 11], "stored left-team-first: left side lost 6-11");
  app.close();
});

test("no top-level name in the page shadows a browser global (e.g. a function called history)", () => {
  const js = HTML.match(/<script>([\s\S]*)<\/script>/)[1];
  const names = new Set([...js.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]));
  for (const m of js.matchAll(/^(?:const|let|var)\s+([^;]+)/gm)) for (const d of m[1].split(/,(?![^(\[{]*[)\]}])/)) { const n = d.trim().match(/^([A-Za-z_$][\w$]*)\s*=/); if (n) names.add(n[1]); }
  const w = new JSDOM("", { url: "https://club.test/" }).window;
  const globals = new Set(["history", "location", "name", "status", "close", "open", "print", "stop", "focus", "blur", "scroll", "top", "parent", "self", "length", "event", "origin", "find", "frames", "opener", "closed", "screen", "navigator", "document", "alert", "confirm", "prompt", "fetch", ...Object.getOwnPropertyNames(w)]);
  w.close();
  const clash = [...names].filter(n => globals.has(n));
  assert.deepEqual(clash, [], "rename these: " + clash.join(", "));
});

test("opening an open play's check-in link, then logging in, checks the player in", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const h = await c.player("hostlink", "198.51.100.41");
  const club = (await c.ok("clubCreate", { name: "Link Club" }, h)).club.id;
  const od = (await c.ok("opCreate", { club, title: "Link night", loc: "Riverside Courts", ts: Date.now() + HOUR, price: 0, cap: 12, courts: 1, rounds: 1 }, h)).od;
  const s = await c.player("scanner", "198.51.100.40");
  await c.ok("opJoin", { id: od.id }, s);
  const code = (await c.ok("opCode", { id: od.id }, h)).code;
  const app = await openApp(c, { url: `https://club.test/?ci=o.${od.id}.${code}` });
  assert.equal(app.w.location.search, "", "code removed from the address bar");
  app.$("#u").value = "scanner"; app.$("#p").value = "secret123";
  app.click("[data-a=auth]");
  await until(() => app.$(".toast")?.textContent.includes("Checked in"), "checked in");
  app.close();
});

test("opening a coach's check-in link, then logging in, checks in the booked player", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const at = (await c.ok("login", { username: "admin", password: "x-admin-pw" })).token;
  const inv = (await c.ok("invite", {}, at)).msg.replace("Invite: ", "");
  const ct = await c.register("coachlink", "198.51.100.42"); await c.ok("redeem", { token: inv }, ct);
  await c.ok("addSession", { kind: "lesson", ts: Date.now() + HOUR, title: "Link lesson", loc: "Test Courts", price: 0, dur: 60 }, ct);
  const p = await c.player("booker", "198.51.100.43");
  const sid = (await c.ok("state", {}, p)).sessions[0].id;
  await c.ok("book", { sessionId: sid }, p);
  const code = (await c.ok("sesCode", { sid }, ct)).code;
  const app = await openApp(c, { url: `https://club.test/?ci=b.${sid}.${code}` });
  app.$("#u").value = "booker"; app.$("#p").value = "secret123";
  app.click("[data-a=auth]");
  await until(() => app.$(".toast")?.textContent.includes("Session completed"), "checked in");
  assert.equal((await c.ok("state", {}, p)).me.xp, 40);
  app.close();
});

test("four players: one enters the score, the others are told exactly what to confirm", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const ts = [];
  for (const n of ["ann", "bob", "cyd", "dan"]) { ts.push(await c.player(n, "198.51.100." + (60 + ts.length))); await c.ok("join", {}, ts.at(-1)); }
  const app0 = await openApp(c, { token: ts[0] });
  await until(() => app0.text().includes("Play your game first"), "locked before min time");
  assert.ok(!app0.$("#sa"), "no score inputs before play time");
  app0.close();
  const { advance, MIN } = await import("./helpers/harness.mjs"); advance(6 * MIN);
  const st = await Promise.all(ts.map(t => c.ok("state", {}, t)));
  const enterer = ts[0], side0 = st[0].match.side;
  const teammate = ts[st.findIndex((x, i) => i > 0 && x.match.side === side0)], opp = ts[st.findIndex(x => x.match.side !== side0)];
  const a = await openApp(c, { token: enterer });
  await until(() => a.text().includes("Step 1: one player enters the final score"), "step 1");
  a.click('[data-a=step][data-v="sa:1"]'); for (let i = 0; i < 4; i++) a.click('[data-a=step][data-v="sb:1"]');
  assert.match(a.$("#spv").textContent, /isn't a valid final score/);
  a.$("#sa").value = "11"; a.$("#sa").dispatchEvent(new a.w.Event("input", { bubbles: true }));
  assert.match(a.$("#spv").textContent, /won 11-4/);
  a.click("[data-a=score]");
  await until(() => a.text().includes("Done on your side"), "entered");
  a.close();
  const b = await openApp(c, { token: opp });
  await until(() => b.text().includes("Step 2: confirm the score"), "step 2 for opponent");
  assert.match(b.text(), /entered: your team lost 4-11/);
  b.click("[data-a=agree]");
  await until(() => b.text().includes("Done on your side"), "confirmed");
  assert.equal((b.text().match(/✓/g) || []).length, 2, "two players show a tick");
  b.close();
  const t = await openApp(c, { token: teammate });
  await until(() => t.text().includes("Yes, we won 11-4"), "teammate sees the same score from their side");
  t.close();
});

test("a game on screen keeps time and unlocks scoring by itself, without a reload", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const ts = [];
  for (const n of ["tick1", "tick2", "tick3", "tick4"]) { ts.push(await c.player(n, "198.51.100." + (80 + ts.length))); await c.ok("join", {}, ts.at(-1)); }
  const app = await openApp(c, { token: ts[0] });
  await until(() => app.text().includes("Playing 0 min"), "fresh game");
  assert.match(app.text(), /Score entry opens in 5 min/);
  const { advance, MIN } = await import("./helpers/harness.mjs");
  advance(7 * MIN); // time passes; nothing about the game itself changes
  app.w.document.dispatchEvent(new app.w.Event("visibilitychange")); // same as a routine background refresh
  await until(() => app.text().includes("Playing 7 min"), "clock moved");
  assert.ok(app.$("#sa"), "score entry unlocked without a reload");
  app.close();
});

test("open play page: tabs, hash deep link, cancelled view", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const h = await c.player("tabhost", "198.51.100.7");
  const club = (await c.ok("clubCreate", { name: "Tab Club" }, h)).club.id;
  const od = (await c.ok("opCreate", { club, title: "Tab night", loc: "Riverside Courts", ts: Date.now() + HOUR, price: 0, cap: 12, courts: 1, rounds: 1 }, h)).od;
  const app = await openApp(c, { token: h });
  await until(() => app.$("[data-a=tab][data-v=open]"), "open play tab");
  app.click("[data-a=tab][data-v=open]");
  await until(() => app.$("[data-a=ov]"), "open play row");
  app.click("[data-a=ov]");
  await until(() => app.$("[role=tablist]"), "tab bar");
  const tabs = () => [...app.w.document.querySelectorAll("[role=tab]")].map(b => b.dataset.v);
  assert.deepEqual(tabs(), ["details", "chat", "players"], "no Queue tab before the game starts");
  assert.equal(app.$("[role=tab][aria-selected=true]").dataset.v, "details");
  assert.ok(app.$("[role=tabpanel] [data-a=opStart]"), "host controls on Details");
  app.click("[data-a=opTab][data-v=chat]");
  await until(() => app.$("#gx"), "chat composer");
  assert.equal(app.w.location.hash, "#chat");
  assert.ok(!app.$("[data-a=opStart]"), "only the selected tab renders");
  app.click("[data-a=opTab][data-v=players]");
  await until(() => app.text().includes("tabhost"), "players list");
  await c.ok("opCancel", { id: od.id }, h);
  app.click("[data-a=opTab][data-v=details]");
  await until(() => /Cancelled\./.test(app.text()), "cancelled banner", 8000);
  assert.ok(!tabs().includes("queue"));
  app.close();
});
