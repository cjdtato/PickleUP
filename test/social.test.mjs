// Friends, chat and hosted open play (v8.1), run through the same API harness as the other tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, advance, MIN, HOUR } from "./helpers/harness.mjs";

const NAMES = ["hosty", "ann", "bob", "cyd", "dee", "eve", "fay"];
// ranked games the host played in need the other team to confirm: do that for every pending game
async function confirmAll(call, ID, id) {
  const nameOf = pid => Object.keys(ID).find(n => ID[n] === pid);
  const od = (await call("opGet", { id }, "hosty")).body.od;
  for (const g of od.g.filter(z => z.cf && !(z.cf[0] && z.cf[1]))) {
    const i = g.cf[0] ? 2 : 0; // first player of the team that has not confirmed
    assert.equal((await call("opConfirm", { id, gid: g.id }, nameOf(g.p[i]))).status, 200);
  }
}
async function setup() {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" }), T = {}, ID = {};
  for (const [i, n] of NAMES.entries()) { T[n] = await c.player(n, "198.51.100." + (i + 10)); ID[n] = (await c.call("state", {}, T[n], "198.51.100.99")).body.me.id; }
  const call = (a, b, who) => c.call(a, b, T[who], "198.51.100.99");
  const club = (await call("clubCreate", { name: "Test Club" }, "hosty")).body.club.id; // every open play belongs to a club
  // players check in by scanning the host's code; the host's phone shows a fresh one whenever it asks
  const arrive = async (id, who) => { for (const n of who) assert.equal((await call("opCheckin", { id, code: (await call("opCode", { id }, "hosty")).body.code }, n)).status, 200, n + " checks in"); };
  return { c, T, ID, call, club, arrive };
}

test("friend requests, accept, remove, and chat only between friends", async () => {
  const { ID, call } = await setup();
  assert.equal((await call("fAdd", { name: "ann" }, "hosty")).body.friends.o.length, 1);
  assert.equal((await call("fAdd", { name: "ann" }, "hosty")).status, 400, "no duplicate requests");
  assert.equal((await call("fAdd", { name: "hosty" }, "hosty")).status, 400, "can't add yourself");
  assert.equal((await call("fAdd", { name: "nobody" }, "hosty")).status, 404);
  assert.equal((await call("send", { id: ID.ann, text: "hi" }, "hosty")).status, 403, "not friends yet");
  assert.equal((await call("state", {}, "ann")).body.friends.i.length, 1);
  assert.equal((await call("fAccept", { id: ID.hosty }, "ann")).body.friends.f.length, 1);
  assert.equal((await call("send", { id: ID.ann, text: "see you Saturday" }, "hosty")).body.msgs.length, 1);
  assert.equal((await call("state", {}, "ann")).body.unread, 1);
  assert.equal((await call("chat", { id: ID.hosty }, "ann")).body.msgs[0].x, "see you Saturday");
  assert.equal((await call("state", {}, "ann")).body.unread, 0, "reading clears unread");
  await call("fRemove", { id: ID.hosty }, "ann");
  assert.equal((await call("send", { id: ID.ann, text: "x" }, "hosty")).status, 403, "removed friends can't chat");
  assert.equal((await call("state", {}, "hosty")).body.friends.f.length, 0);
});

test("two requests crossing become a friendship", async () => {
  const { ID, call } = await setup();
  await call("fAdd", { name: "bob" }, "ann");
  assert.equal((await call("fAdd", { name: "ann" }, "bob")).body.friends.f.length, 1);
  assert.equal((await call("state", {}, "ann")).body.friends.f[0].id, ID.bob);
});

test("open play: join, pay, shuffled queue, scores, ranking", async () => {
  const { ID, call, club, arrive } = await setup();
  const mk = { club, title: "Sat open play", loc: "Riverside Courts", ts: Date.now() + 36e5, price: 100, pay: "GCash 0917", cap: 12, courts: 2, rounds: 3 };
  assert.equal((await call("opCreate", { ...mk, pay: "" }, "hosty")).status, 400, "paid sessions need payment details");
  const id = (await call("opCreate", mk, "hosty")).body.od.id;
  assert.equal((await call("opStart", { id }, "hosty")).status, 400, "needs 4 paid players");
  for (const n of NAMES.slice(1)) assert.equal((await call("opJoin", { id }, n)).status, 200);
  assert.equal((await call("opJoin", { id }, "ann")).status, 400, "no double join");
  assert.equal((await call("opPaid", { id, pid: ID.ann }, "ann")).status, 403, "only the host confirms payment");
  for (const n of ["ann", "bob", "cyd", "dee", "eve"]) await call("opPaid", { id, pid: ID[n] }, "hosty");
  assert.equal((await call("opStart", { id }, "hosty")).status, 400, "paid, but nobody has scanned in yet");
  await arrive(id, ["ann", "bob", "cyd", "dee"]); // eve paid but never scanned
  assert.equal((await call("opCheckin", { id, code: (await call("opCode", { id }, "hosty")).body.code }, "fay")).status, 400, "fay has not paid, so she cannot check in");
  assert.equal((await call("opArrive", { id, pid: ID.fay }, "hosty")).status, 400, "the host cannot check in an unpaid player either");
  assert.equal((await call("opStart", { id }, "ann")).status, 403, "only the host starts");
  await call("opHostIn", { id: id }, "hosty");
  let od = (await call("opStart", { id }, "hosty")).body.od;
  assert.equal(od.st, "live");
  const games = new Map(); od.g.forEach(g => g.p.forEach(p => games.set(p, (games.get(p) || 0) + 1)));
  assert.equal(games.size, 5, "only players who paid and checked in are scheduled");
  assert.ok(!games.has(ID.fay), "unpaid player is not in any game");
  assert.ok(!games.has(ID.eve), "a paid player who never scanned is not in any game");
  assert.ok([...games.values()].every(n => n >= 3), "everyone gets at least 3 games");
  for (let i = 0; i < 40; i++) {
    od = (await call("opGet", { id }, "hosty")).body.od;
    const on = od.g.filter(g => g.st === "p");
    assert.equal(new Set(on.flatMap(g => g.p)).size, on.length * 4, "nobody on two courts");
    if (!on.length) break;
    assert.equal((await call("opScore", { id, gid: on[0].id, a: 11, b: 8 }, "hosty")).status, 200);
  }
  assert.ok(od.g.every(g => g.st === "d") && od.finished > 0);
  assert.equal(od.rank.reduce((t, r) => t + r.g, 0), od.finished * 4);
  assert.equal((await call("opEnd", { id }, "hosty")).body.od.st, "ended");
});

test("host can add a court and more games; ranked sessions change ratings only when ended, casual never", async () => {
  const { ID, call, club, arrive } = await setup();
  const mk = { club, loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 20, courts: 1, rounds: 1 };
  const run = async (mode, title) => {
    const id = (await call("opCreate", { ...mk, title, mode }, "hosty")).body.od.id;
    for (const n of NAMES.slice(1)) await call("opJoin", { id }, n); // free: everyone is in once they scan
    await arrive(id, NAMES.slice(1));
    return id;
  };
  const rid = await run("ranked", "Ranked night");
  assert.equal((await call("opGet", { id: rid }, "ann")).body.od.mode, "ranked");
  assert.equal((await call("opStart", { id: rid }, "hosty")).status, 400, "ranked needs 8 paid players");
  const cid = await run("casual", "Casual night");
  await call("opHostIn", { id: cid }, "hosty");
  let od = (await call("opStart", { id: cid }, "hosty")).body.od;
  assert.equal(od.g.filter(g => g.st === "p").length, 1, "one court");
  od = (await call("opCourt", { id: cid }, "hosty")).body.od;
  assert.equal(od.courts, 2);
  assert.equal((await call("opCourt", { id: cid }, "ann")).status, 403, "only the host adds courts");
  const before = od.g.length;
  od = (await call("opMore", { id: cid }, "hosty")).body.od;
  assert.equal(od.rounds, 2); assert.ok(od.g.length > before, "more games queued");
  for (let i = 0; i < 60; i++) {
    od = (await call("opGet", { id: cid }, "hosty")).body.od;
    const g = od.g.find(x => x.st === "p"); if (!g) break;
    await call("opScore", { id: cid, gid: g.id, a: 11, b: 4 }, "hosty");
  }
  await call("opEnd", { id: cid }, "hosty");
  assert.equal((await call("state", {}, "ann")).body.me.pr, 3.5, "casual leaves the rating untouched");
  assert.equal((await call("state", {}, "ann")).body.me.hist.length, 0);
});

test("ranked open play: ratings update once, when the host ends it", async () => {
  const { c, T, ID, call, club, arrive } = await setup();
  T.gus = await c.player("gus", "198.51.100.77");
  const all = [...NAMES, "gus"];
  const id = (await call("opCreate", { club, title: "Ranked night", loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 20, courts: 2, rounds: 2, mode: "ranked" }, "hosty")).body.od.id;
  for (const n of all.slice(1)) await call("opJoin", { id }, n);
  await arrive(id, all.slice(1));
  await call("opHostIn", { id: id }, "hosty");
  let od = (await call("opStart", { id }, "hosty")).body.od;
  assert.equal(od.st, "live");
  for (let i = 0; i < 60; i++) {
    od = (await call("opGet", { id }, "hosty")).body.od;
    const g = od.g.find(x => x.st === "p"); if (!g) break;
    if (i === 0) {
      assert.equal((await call("opScore", { id, gid: g.id, a: 1, b: 0 }, "hosty")).status, 400, "ranked scores follow the normal score rules");
      assert.equal((await call("opScore", { id, gid: g.id, a: 11, b: 10 }, "hosty")).status, 400, "must win by 2");
    }
    await call("opScore", { id, gid: g.id, a: 11, b: 5 }, "hosty");
  }
  const hist = async n => (await call("state", {}, n)).body.me.hist.length;
  for (const n of all) assert.equal(await hist(n), 0, "no rating change while the session is running");
  await confirmAll(call, ID, id);
  const r = await call("opEnd", { id }, "hosty");
  assert.equal(r.body.od.applied, true);
  const total = (await Promise.all(all.map(hist))).reduce((t, x) => t + x, 0);
  assert.equal(total, r.body.od.finished * 4, "every finished game counted for all four players");
  assert.equal((await call("opEnd", { id }, "hosty")).status, 400, "can't end twice, so ratings can't be applied twice");
});

test("every player keeps a personal match history across all open plays, casual and ranked", async () => {
  const { ID, call, club, arrive } = await setup();
  const play = async (title, mode, who) => {
    const id = (await call("opCreate", { club, title, loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 20, courts: 1, rounds: 1, mode }, "hosty")).body.od.id;
    for (const n of who) await call("opJoin", { id }, n);
    await arrive(id, who);
    await call("opHostIn", { id: id }, "hosty");
    await call("opStart", { id }, "hosty");
    for (let i = 0; i < 20; i++) {
      const od = (await call("opGet", { id }, "hosty")).body.od, g = od.g.find(x => x.st === "p"); if (!g) break;
      await call("opScore", { id, gid: g.id, a: 11, b: 6 }, "hosty");
    }
    return id;
  };
  const first = await play("Casual morning", "casual", ["ann", "bob", "cyd"]);
  assert.equal((await call("profile", { id: ID.ann }, "ann")).body.profile.hist.length, 0, "nothing is logged while the session runs");
  await call("opEnd", { id: first }, "hosty");
  const second = await play("Casual evening", "casual", ["ann", "bob", "cyd"]);
  await call("opEnd", { id: second }, "hosty");
  await call("opEnd", { id: second }, "hosty"); // ending twice must not log twice
  const h = (await call("profile", { id: ID.ann }, "bob")).body.profile.hist;
  assert.equal(h.length, 2, "one game in each open play");
  assert.deepEqual(h.map(x => x.ot).sort(), ["Casual evening", "Casual morning"]);
  assert.ok(h.every(x => x.k === "casual" && x.d == null && x.pt && x.op.length === 2));
  assert.equal((await call("profile", { id: ID.hosty }, "ann")).body.profile.hist.length, 2, "the host's games count too");
});

test("open play check-in: the code is per open play, only joined players can use it, it expires, and the host can check people in by hand", async () => {
  const { ID, call, club, arrive } = await setup();
  const mk = { club, loc: "Riverside Courts", ts: Date.now() + HOUR, price: 0, cap: 12, courts: 1, rounds: 1 };
  const one = (await call("opCreate", { ...mk, title: "Saturday" }, "hosty")).body.od.id, two = (await call("opCreate", { ...mk, title: "Sunday" }, "hosty")).body.od.id;
  for (const n of ["ann", "bob", "cyd", "dee"]) await call("opJoin", { id: one }, n);
  await call("opJoin", { id: two }, "ann");
  assert.equal((await call("opCode", { id: one }, "ann")).status, 403, "only the host shows the code");
  const code1 = (await call("opCode", { id: one }, "hosty")).body.code, code2 = (await call("opCode", { id: two }, "hosty")).body.code;
  assert.match(code1, /^[A-Z0-9]{8}$/); assert.notEqual(code1, code2, "each open play has its own code");
  assert.equal((await call("opCheckin", { id: one, code: "WRONG123" }, "ann")).status, 400);
  assert.equal((await call("opCheckin", { id: two, code: code1 }, "ann")).status, 400, "another open play's code is refused");
  assert.equal((await call("opCheckin", { id: one, code: code1 }, "eve")).status, 400, "you have to join before you can scan");
  let od = (await call("opGet", { id: one }, "ann")).body.od;
  assert.equal(od.qr, true); assert.equal(od.pl.find(p => p.me).here, false, "joined is not the same as here");
  advance(2 * MIN); // a code lives about 3 minutes, so a slow scan still works
  assert.equal((await call("opCheckin", { id: one, code: code1 }, "ann")).status, 200);
  assert.equal((await call("opGet", { id: one }, "ann")).body.od.pl.find(p => p.me).here, true);
  advance(5 * MIN);
  assert.equal((await call("opCheckin", { id: one, code: code1 }, "bob")).status, 400, "an old screenshot is useless");
  // host fallback for a phone that can't scan: toggle
  assert.equal((await call("opArrive", { id: one, pid: ID.bob }, "bob")).status, 403, "only the host checks people in by hand");
  od = (await call("opArrive", { id: one, pid: ID.bob }, "hosty")).body.od;
  assert.equal(od.pl.find(p => p.id === ID.bob).here, true);
  od = (await call("opCheckout", { id: one, pid: ID.bob }, "hosty")).body.od;
  assert.equal(od.pl.find(p => p.id === ID.bob).here, false, "the host can check them out again");
  assert.equal((await call("opArrive", { id: one, pid: ID.hosty }, "hosty")).status, 400, "the host is always here");
  // too early: check-in opens 2 hours before the start
  const later = (await call("opCreate", { ...mk, title: "Next week", ts: Date.now() + 5 * HOUR }, "hosty")).body.od.id;
  await call("opJoin", { id: later }, "ann");
  const codeL = (await call("opCode", { id: later }, "hosty")).body.code;
  assert.equal((await call("opCheckin", { id: later, code: codeL }, "ann")).status, 400);
  // brute force is rate limited
  for (let i = 0; i < 10; i++) await call("opCheckin", { id: one, code: "NOPE000" + i }, "cyd");
  assert.equal((await call("opCheckin", { id: one, code: (await call("opCode", { id: one }, "hosty")).body.code }, "cyd")).status, 429);
  // nobody scanned in, so the games can't start: the host plus ann is not enough
  assert.equal((await call("opStart", { id: one }, "hosty")).status, 400);
  await arrive(one, ["dee"]);
});

test("open play check-out: the host checks a player out; they keep finished games and can scan again to return", async () => {
  const { ID, call, club, arrive } = await setup();
  const id = (await call("opCreate", { club, title: "Check-out night", loc: "Riverside Courts", ts: Date.now() + HOUR, price: 0, cap: 12, courts: 1, rounds: 2 }, "hosty")).body.od.id;
  for (const n of NAMES.slice(1)) await call("opJoin", { id }, n);
  await arrive(id, NAMES.slice(1));
  await call("opHostIn", { id: id }, "hosty");
  let od = (await call("opStart", { id }, "hosty")).body.od;
  const onCourt = new Set(od.g.filter(g => g.st === "p").flatMap(g => g.p));
  const busy = NAMES.slice(1).find(n => onCourt.has(ID[n])), idle = NAMES.slice(1).find(n => !onCourt.has(ID[n]));
  assert.equal((await call("opCheckout", { id, pid: ID[idle] }, idle)).status, 403, "players can't check themselves out; the host does it");
  assert.equal((await call("opCheckout", { id, pid: ID[busy] }, "hosty")).status, 400, "not while they're on a court");
  assert.equal((await call("opCheckout", { id, pid: ID.hosty }, "hosty")).status, 400, "the host is always here");
  od = (await call("opCheckout", { id, pid: ID[idle] }, "hosty")).body.od;
  const me = od.pl.find(p => p.id === ID[idle]);
  assert.equal(me.here, false); assert.equal(me.out, true);
  assert.ok(od.g.every(g => g.st === "d" || !g.p.includes(ID[idle])), "no waiting games for someone who left");
  assert.equal((await call("opCheckout", { id, pid: ID[idle] }, "hosty")).status, 400, "already out");
  // finish the game the busy player is on: it counts, then the host can check them out
  for (let i = 0; i < 10; i++) { // the next queued game may put them straight back on court: score those too
    const g = od.g.find(x => x.st === "p" && x.p.includes(ID[busy])); if (!g) break;
    od = (await call("opScore", { id, gid: g.id, a: 11, b: 3 }, "hosty")).body.od;
  }
  od = (await call("opCheckout", { id, pid: ID[busy] }, "hosty")).body.od;
  assert.ok(od.g.some(x => x.st === "d" && x.p.includes(ID[busy])), "their finished game still counts");
  assert.ok(od.rank.some(r => r.id === ID[busy] && r.g >= 1), "and stays in the ranking");
  // scanning again brings them back into the queue
  const code = (await call("opCode", { id }, "hosty")).body.code;
  od = (await call("opCheckin", { id, code }, idle)).body.od;
  assert.equal(od.pl.find(p => p.id === ID[idle]).here, true); assert.equal(od.pl.find(p => p.id === ID[idle]).out, false);
  assert.ok(od.g.some(x => x.st !== "d" && x.p.includes(ID[idle])), "back in the queue");
});

test("ranked open play: can't end while games are still on court", async () => {
  const { c, T, call, club, arrive } = await setup();
  T.gus = await c.player("gus", "198.51.100.78");
  const all = [...NAMES, "gus"];
  const id = (await call("opCreate", { club, title: "Ranked guard", loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 20, courts: 2, rounds: 1, mode: "ranked" }, "hosty")).body.od.id;
  for (const n of all.slice(1)) await call("opJoin", { id }, n);
  await arrive(id, all.slice(1));
  await call("opHostIn", { id: id }, "hosty");
  let od = (await call("opStart", { id }, "hosty")).body.od;
  const g = od.g.find(x => x.st === "p");
  assert.ok(g, "a game is on court");
  assert.equal((await call("opEnd", { id }, "hosty")).status, 400, "unfinished game blocks ending, so nothing is silently dropped");
  assert.equal((await call("opVoid", { id, gid: g.id }, "hosty")).status, 200);
});

test("paid open play: leaving keeps the payment until the host refunds it, rejoining is free, a refund means paying again", async () => {
  const { ID, call, club } = await setup();
  const mk = { club, loc: "Riverside Courts", ts: Date.now() + HOUR, price: 100, pay: "GCash 0917", cap: 12, courts: 1, rounds: 1 };
  const id = (await call("opCreate", { ...mk, title: "Paid night" }, "hosty")).body.od.id;
  await call("opJoin", { id }, "ann");
  await call("opJoin", { id }, "bob");
  await call("opPaid", { id, pid: ID.ann }, "hosty");
  await call("opPaid", { id, pid: ID.bob }, "hosty");
  // ann leaves after paying: gone from the player list, held as a credit the host can see
  await call("opLeave", { id }, "ann");
  let od = (await call("opGet", { id }, "hosty")).body.od;
  const held = od.pl.find(p => p.id === ID.ann);
  assert.ok(held && held.left && held.cr, "the host sees a left-and-paid player");
  assert.equal((await call("opGet", { id }, "bob")).body.od.pl.some(p => p.id === ID.ann), false, "other players do not see them");
  assert.equal((await call("opRefund", { id, pid: ID.ann }, "bob")).status, 403, "only the host refunds");
  // rejoin before a refund: still paid, no second payment, must check in again
  assert.equal((await call("opJoin", { id }, "ann")).status, 200);
  od = (await call("opGet", { id }, "ann")).body.od;
  assert.equal(od.pl.find(p => p.me).paid, true, "the earlier payment still counts");
  assert.equal(od.pl.filter(p => p.me).length, 1, "no duplicate entry");
  // leave again, host refunds: the credit is gone and rejoining needs a new payment
  await call("opLeave", { id }, "ann");
  assert.equal((await call("opRefund", { id, pid: ID.ann }, "hosty")).status, 200);
  assert.equal((await call("opRefund", { id, pid: ID.ann }, "hosty")).status, 400, "nothing left to refund");
  assert.equal((await call("opGet", { id }, "hosty")).body.od.pl.some(p => p.id === ID.ann), false);
  await call("opJoin", { id }, "ann");
  assert.equal((await call("opGet", { id }, "ann")).body.od.pl.find(p => p.me).paid, false, "after a refund they pay again");
  // a free open play is unchanged: leaving just removes you
  const free = (await call("opCreate", { ...mk, price: 0, title: "Free night" }, "hosty")).body.od.id;
  await call("opJoin", { id: free }, "bob"); await call("opLeave", { id: free }, "bob");
  assert.equal((await call("opGet", { id: free }, "hosty")).body.od.pl.some(p => p.id === ID.bob), false);
});

test("v8.14: last-active, challenge and open-play invite go through chat to friends only", async () => {
  const { ID, call } = await setup();
  await call("fAdd", { name: "ann" }, "hosty"); await call("fAccept", { id: ID.hosty }, "ann");
  assert.equal((await call("fInvite", { id: ID.bob, kind: "challenge" }, "hosty")).status, 403, "not friends");
  assert.equal((await call("fInvite", { id: ID.ann, kind: "nope" }, "hosty")).status, 400);
  assert.equal((await call("fInvite", { id: ID.ann, kind: "challenge" }, "hosty")).status, 200);
  assert.equal((await call("fInvite", { id: ID.ann, kind: "op", op: "missing" }, "hosty")).status, 400, "unknown open play");
  const st = await call("state", {}, "ann");
  assert.equal(st.body.unread, 1);
  assert.match((await call("chat", { id: ID.hosty }, "ann")).body.msgs[0].x, /challenges you/);
});

test("v8.25: ranked open play damps XP and rating when the same players repeat across sessions", async () => {
  const { c, T, call, club, arrive } = await setup();
  T.gus = await c.player("gus", "198.51.100.77");
  const all = [...NAMES, "gus"], dampedAfter = [];
  for (let s = 0; s < 2; s++) {
    const id = (await call("opCreate", { club, title: "Repeat " + s, loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 20, courts: 2, rounds: 6, mode: "ranked" }, "hosty")).body.od.id;
    for (const n of all.slice(1)) await call("opJoin", { id }, n);
    await arrive(id, all.slice(1));
    await call("opHostIn", { id: id }, "hosty");
    const st = await call("opStart", { id }, "hosty"); assert.equal(st.body.od && st.body.od.st, "live", JSON.stringify(st.body));
    for (let i = 0; i < 80; i++) {
      const g = (await call("opGet", { id }, "hosty")).body.od.g.find(z => z.st === "p"); if (!g) break;
      await call("opScore", { id, gid: g.id, a: 11, b: 5 }, "hosty");
    }
    assert.equal((await call("opEnd", { id }, "hosty")).status, 200);
    let n = 0; for (const p of all) n += (await call("state", {}, p)).body.me.hist.filter(h => h.rm < 1).length;
    dampedAfter.push(n);
  }
  assert.equal(dampedAfter[0], 0, "games inside one session never damp each other");
  assert.ok(dampedAfter[1] > 0, "the same players meeting again in a later session are damped");
});

test("open play scores: only the host enters them; a playing host's ranked game needs the other team", async () => {
  const { c, T, ID, call, club, arrive } = await setup();
  T.gus = await c.player("gus", "198.51.100.77"); ID.gus = (await call("state", {}, "gus")).body.me.id;
  const all = [...NAMES, "gus"];
  const id = (await call("opCreate", { club, title: "Host plays", loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 20, courts: 2, rounds: 2, mode: "ranked" }, "hosty")).body.od.id;
  for (const n of all) await call("opJoin", { id }, n);
  await arrive(id, all);
  await call("opHostIn", { id: id }, "hosty");
  let od = (await call("opStart", { id }, "hosty")).body.od;
  const nameOf = pid => Object.keys(ID).find(n => ID[n] === pid);
  const mine = od.g.find(g => g.st === "p" && g.p.includes(ID.hosty)), other = od.g.find(g => g.st === "p" && !g.p.includes(ID.hosty));
  assert.ok(mine, "host is scheduled in a game");
  assert.equal((await call("opScore", { id, gid: mine.id, a: 11, b: 5 }, nameOf(mine.p.find(p => p !== ID.hosty)))).status, 403, "a player cannot enter the score");
  assert.equal((await call("opConfirm", { id, gid: mine.id }, "ann")).status, 400, "nothing to confirm before a score exists");
  assert.equal((await call("opScore", { id, gid: mine.id, a: 11, b: 5 }, "hosty")).status, 200);
  const hostFirst = mine.p.indexOf(ID.hosty) < 2, g = (await call("opGet", { id }, "hosty")).body.od.g.find(x => x.id === mine.id);
  assert.deepEqual(g.cf, hostFirst ? [1, 0] : [0, 1], "host entered for their own team only");
  assert.equal((await call("opConfirm", { id, gid: mine.id }, nameOf(mine.p[hostFirst ? 1 : 3]))).status, 400, "host's own team cannot confirm");
  assert.equal((await call("opConfirm", { id, gid: mine.id }, "gus")).status === 403 || mine.p.includes(ID.gus), true, "non-players cannot confirm");
  if (other) { assert.equal((await call("opScore", { id, gid: other.id, a: 11, b: 4 }, "hosty")).status, 200, "host not playing: entry is final"); assert.deepEqual((await call("opGet", { id }, "hosty")).body.od.g.find(x => x.id === other.id).cf, [1, 1]); }
  assert.equal((await call("opConfirm", { id, gid: mine.id }, nameOf(mine.p[hostFirst ? 2 : 0]))).status, 200, "opposing team confirms");
  assert.equal((await call("opConfirm", { id, gid: mine.id }, nameOf(mine.p[hostFirst ? 3 : 1]))).status, 400, "already confirmed");
  for (let i = 0; i < 40; i++) {
    od = (await call("opGet", { id }, "hosty")).body.od; const x = od.g.find(z => z.st === "p"); if (!x) break;
    await call("opScore", { id, gid: x.id, a: 11, b: 3 }, "hosty");
  }
  await confirmAll(call, ID, id);
  const r = await call("opEnd", { id }, "hosty");
  assert.equal(r.status, 200);
});

test("ranked open play: unconfirmed games do not count toward ratings", async () => {
  const { c, T, ID, call, club, arrive } = await setup();
  T.gus = await c.player("gus", "198.51.100.77");
  const all = [...NAMES, "gus"];
  const id = (await call("opCreate", { club, title: "Unconfirmed", loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 20, courts: 1, rounds: 1, mode: "ranked" }, "hosty")).body.od.id;
  for (const n of all) await call("opJoin", { id }, n);
  await arrive(id, all);
  await call("opHostIn", { id: id }, "hosty");
  await call("opStart", { id }, "hosty");
  let od, n = 0;
  for (let i = 0; i < 40; i++) {
    od = (await call("opGet", { id }, "hosty")).body.od; const g = od.g.find(z => z.st === "p"); if (!g) break;
    await call("opScore", { id, gid: g.id, a: 11, b: 6 }, "hosty"); n++;
  }
  od = (await call("opGet", { id }, "hosty")).body.od;
  const unc = od.g.filter(z => z.cf && !(z.cf[0] && z.cf[1])).length;
  assert.ok(unc > 0, "at least one game involves the host and stays unconfirmed");
  const r = await call("opEnd", { id }, "hosty");
  assert.match(r.body.msg || r.body.message || JSON.stringify(r.body), /not counted/);
  const total = (await Promise.all(all.map(async p => (await call("state", {}, p)).body.me.hist.length))).reduce((t, x) => t + x, 0);
  assert.equal(total, (od.finished - unc) * 4, "only confirmed games rated");
});

test("host is listed as a player but only plays once checked in", async () => {
  const { ID, call, club, arrive } = await setup();
  const id = (await call("opCreate", { club, title: "Host sits out", loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 20, courts: 1, rounds: 2 }, "hosty")).body.od.id;
  for (const n of ["ann", "bob", "cyd", "dee"]) await call("opJoin", { id }, n);
  await arrive(id, ["ann", "bob", "cyd", "dee"]);
  let od = (await call("opGet", { id }, "hosty")).body.od;
  const row = od.pl.find(p => p.id === ID.hosty);
  assert.ok(row && !row.here, "host is in the player list, not checked in");
  assert.equal((await call("opHostIn", { id }, "ann")).status, 403, "only the host checks the host in");
  od = (await call("opStart", { id }, "hosty")).body.od;
  assert.ok(!od.g.some(g => g.p.includes(ID.hosty)), "unchecked host is in no game");
  od = (await call("opHostIn", { id }, "hosty")).body.od;
  assert.ok(od.pl.find(p => p.id === ID.hosty).here, "host checked in");
  od = (await call("opHostOut", { id }, "hosty")).body.od;
  assert.ok(!od.pl.find(p => p.id === ID.hosty).here && !od.g.some(g => g.st === "q" && g.p.includes(ID.hosty)), "checked out: no waiting games");
});

test("open play settings: fixed pairing and player swapping are host options, off by default", async () => {
  const { c, T, ID, call, club, arrive } = await setup();
  const mk = o => call("opCreate", { club, title: "Pairs night", loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 20, courts: 1, rounds: 3, ...o }, "hosty");
  const off = (await mk({})).body.od, on = (await mk({ fp: true, sw: true })).body.od;
  assert.equal(off.fp, false); assert.equal(off.sw, false); assert.equal(on.fp, true); assert.equal(on.sw, true);
  const nameOf = pid => Object.keys(ID).find(n => ID[n] === pid);
  for (const n of ["ann", "bob", "cyd", "dee"]) { await call("opJoin", { id: off.id }, n); await call("opJoin", { id: on.id }, n); }
  assert.equal((await call("opPair", { id: off.id, a: ID.ann, b: ID.bob }, "hosty")).status, 400, "not allowed when the host left it off");
  await arrive(off.id, ["ann", "bob", "cyd", "dee"]); await arrive(on.id, ["ann", "bob", "cyd", "dee"]);
  await call("opStart", { id: off.id }, "hosty");
  assert.equal((await call("opSwap", { id: off.id, gid: "x", out: ID.ann, in: ID.bob }, "hosty")).status, 400, "swapping off");
  // allowed session
  assert.equal((await call("opPair", { id: on.id, a: ID.ann, b: ID.bob }, "ann")).status, 403, "only the host pairs");
  assert.equal((await call("opPair", { id: on.id, a: ID.ann, b: ID.bob }, "hosty")).status, 200);
  assert.equal((await call("opPair", { id: on.id, a: ID.ann, b: ID.cyd }, "hosty")).status, 400, "already paired");
  let od = (await call("opStart", { id: on.id }, "hosty")).body.od;
  assert.ok(od.g.length >= 3);
  for (const g of od.g) { const i = g.p.indexOf(ID.ann), j = g.p.indexOf(ID.bob); if (i >= 0 || j >= 0) assert.ok(i >= 0 && j >= 0 && Math.floor(i / 2) === Math.floor(j / 2), "ann and bob always on the same team"); }
  // swap in a waiting game
  const q = od.g.find(g => g.st === "q");
  if (q) {
    const out = q.p[0], inn = [ID.ann, ID.bob, ID.cyd, ID.dee].find(x => !q.p.includes(x) && !od.g.some(g => g.st === "p" && g.p.includes(x)));
    if (inn) { const r = await call("opSwap", { id: on.id, gid: q.id, out, in: inn }, "hosty"); assert.equal(r.status, 200); assert.ok(r.body.od.g.find(g => g.id === q.id).p.includes(inn)); }
  }
  const on0 = od.g.find(g => g.st === "p");
  assert.equal((await call("opSwap", { id: on.id, gid: on0.id, out: on0.p[0], in: ID.dee }, "hosty")).status, 400, "games on court cannot be changed");
  assert.equal((await call("opUnpair", { id: on.id, pid: ID.ann }, "hosty")).status, 200);
});

test("open play: check-in needs payment first, pairs need paid and checked-in players, host can switch options on later", async () => {
  const { ID, call, club, arrive } = await setup();
  const od = (await call("opCreate", { club, title: "Paid first", loc: "Riverside Courts", ts: Date.now() + 36e5, price: 500, pay: "GCash 0917", cap: 20, courts: 1, rounds: 3, fp: true }, "hosty")).body.od, id = od.id;
  for (const n of ["ann", "bob", "cyd"]) await call("opJoin", { id }, n);
  const scan = async n => (await call("opCheckin", { id, code: (await call("opCode", { id }, "hosty")).body.code }, n)).status;
  assert.equal(await scan("ann"), 400, "unpaid players cannot scan in");
  assert.equal((await call("opArrive", { id, pid: ID.ann }, "hosty")).status, 400, "the host cannot check in an unpaid player");
  for (const n of ["ann", "bob"]) await call("opPaid", { id, pid: ID[n] }, "hosty");
  assert.equal((await call("opPair", { id, a: ID.ann, b: ID.bob }, "hosty")).status, 400, "paid but not checked in");
  await arrive(id, ["ann", "bob"]);
  assert.equal((await call("opPair", { id, a: ID.ann, b: ID.cyd }, "hosty")).status, 400, "cyd has not paid");
  assert.equal((await call("opPair", { id, a: ID.ann, b: ID.bob }, "hosty")).status, 200, "paid and checked in");
  const od2 = (await call("opPaid", { id, pid: ID.bob }, "hosty")).body.od; // unpay bob
  assert.equal(od2.pairs.length, 0, "unpaying removes the pair");
  assert.equal(od2.pl.find(p => p.id === ID.bob).here, false, "and checks them out");
  assert.equal((await call("opOpt", { id, k: "sw" }, "ann")).status, 403, "only the host");
  assert.equal((await call("opOpt", { id, k: "sw" }, "hosty")).body.od.sw, true, "swap switched on after creation");
});
