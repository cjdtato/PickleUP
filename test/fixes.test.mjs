// Regression tests: partial club edits, approval-only open play, public ended/cancelled lists, chat send result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh } from "./helpers/harness.mjs";

const NAMES = ["owny", "ann", "bob", "cyd", "dee", "eve", "zed"];
async function setup() {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" }), T = {}, ID = {};
  for (const [i, n] of NAMES.entries()) { T[n] = await c.player(n, "198.51.100." + (i + 10)); ID[n] = (await c.call("state", {}, T[n], "198.51.100.99")).body.me.id; }
  const call = (a, b, who) => c.call(a, b, T[who], "198.51.100.99");
  const arrive = async (id, who) => { for (const n of who) await call("opCheckin", { id, code: (await call("opCode", { id }, "owny")).body.code }, n); };
  return { call, ID, arrive };
}
const mk = club => ({ club, title: "Sat play", loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 12, courts: 1, rounds: 1 });

test("a partial club edit changes only what it sends", async () => {
  const { call } = await setup();
  const club = (await call("clubCreate", { name: "Rules Club", desc: "hi", rules: "Be on time.", loc: "Riverside", ap: true, ho: true }, "owny")).body.club;
  let c = (await call("clubUpdate", { id: club.id, name: "Renamed Club" }, "owny")).body.club;
  assert.deepEqual([c.n, c.rules, c.d, c.loc, c.ap, c.ho], ["Renamed Club", "Be on time.", "hi", "Riverside", true, true]);
  c = (await call("clubUpdate", { id: club.id, rules: "New rules" }, "owny")).body.club;
  assert.deepEqual([c.n, c.rules, c.ap, c.ho], ["Renamed Club", "New rules", true, true], "rules-only keeps the name and policies");
  c = (await call("clubUpdate", { id: club.id, ap: false }, "owny")).body.club;
  assert.deepEqual([c.ap, c.ho], [false, true], "one flag at a time");
});

test("approval-only clubs: no joining their open play or its chat without membership", async () => {
  const { call, ID } = await setup();
  const club = (await call("clubCreate", { name: "Closed Club", ap: true }, "owny")).body.club;
  const id = (await call("opCreate", mk(club.id), "owny")).body.od.id;
  assert.equal((await call("opJoin", { id }, "ann")).status, 403, "outsider can't join");
  assert.equal((await call("gcGet", { kind: "op", id }, "ann")).status, 403, "can't read the chat");
  assert.equal((await call("gcSend", { kind: "op", id, text: "hi" }, "ann")).status, 403, "can't write the chat");
  await call("clubJoin", { id: club.id }, "ann");
  assert.equal((await call("opJoin", { id }, "ann")).status, 403, "a pending request is not membership");
  await call("clubApprove", { id: club.id, pid: ID.ann }, "owny");
  assert.equal((await call("opJoin", { id }, "ann")).status, 200, "approved members join");
  const s = await call("gcSend", { kind: "op", id, text: "hello" }, "ann");
  assert.equal(s.status, 200);
  assert.equal(s.body.msgs.at(-1).x, "hello", "the send result carries the message");
});

test("ended and cancelled open plays are visible to people who were not in them", async () => {
  const { call, arrive } = await setup();
  const club = (await call("clubCreate", { name: "Open Club" }, "owny")).body.club;
  const live = (await call("opCreate", mk(club.id), "owny")).body.od.id;
  for (const n of ["ann", "bob", "cyd", "dee"]) await call("opJoin", { id: live }, n);
  await arrive(live, ["ann", "bob", "cyd", "dee"]);
  await call("opHostIn", { id: live }, "owny");
  assert.equal((await call("opStart", { id: live }, "owny")).status, 200);
  assert.equal((await call("opEnd", { id: live }, "owny")).body.od.st, "ended");
  const cancelled = (await call("opCreate", mk(club.id), "owny")).body.od.id;
  assert.equal((await call("opCancel", { id: cancelled }, "owny")).status, 200);
  const ops = (await call("state", {}, "zed")).body.ops;
  assert.equal(ops.find(o => o.id === live)?.st, "ended");
  assert.equal(ops.find(o => o.id === cancelled)?.st, "cancelled");
});
