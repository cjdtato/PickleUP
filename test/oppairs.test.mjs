// Open play leftovers: pairs rebuild the waiting games (D1), a pair is split only when it must be and the host is told (D2),
// swapping tells the host when a second game changed (D3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh } from "./helpers/harness.mjs";

const NAMES = ["owny", "ann", "bob", "cyd", "dee", "eve"];
test("pairs rebuild waiting games and an uneven group still gets every game", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" }), T = {}, ID = {};
  for (const [i, n] of NAMES.entries()) { T[n] = await c.player(n, "198.51.100." + (i + 10)); ID[n] = (await c.call("state", {}, T[n], "198.51.100.99")).body.me.id; }
  const call = (a, b, who) => c.call(a, b, T[who], "198.51.100.99");
  const club = (await call("clubCreate", { name: "Pair Club" }, "owny")).body.club;
  const id = (await call("opCreate", { club: club.id, title: "Sat", loc: "Courts", ts: Date.now() + 36e5, price: 0, cap: 12, courts: 1, rounds: 3, fp: true, sw: true }, "owny")).body.od.id;
  const four = ["ann", "bob", "cyd", "dee", "eve"];
  for (const n of four) await call("opJoin", { id }, n);
  for (const n of four) await call("opCheckin", { id, code: (await call("opCode", { id }, "owny")).body.code }, n);
  assert.equal((await call("opStart", { id }, "owny")).status, 200);
  const r = await call("opPair", { id, a: ID.ann, b: ID.bob }, "owny");
  assert.equal(r.status, 200); assert.match(r.body.msg || r.body.message || "", /rebuilt/i, "pair while live says the waiting games were rebuilt");
  assert.equal((await call("opPair", { id, a: ID.cyd, b: ID.dee }, "owny")).status, 200);
  const od = (await call("opGet", { id }, "owny")).body.od || (await call("opGet", { id }, "owny")).body;
  const games = (od.g || od.games || od.q || []);
  assert.ok(games.length >= 3 && games.length <= 8, "everyone gets games, no endless loop: " + games.length);
  assert.ok(od.pw > 0, "the host is told that a pair had to be split (5 players, 2 pairs)");
});
