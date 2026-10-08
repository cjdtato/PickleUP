// Phase 2 (v8.18): server-side read markers, unread per open play, pinned note (host/owner only, 200 chars, rate limited).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh } from "./helpers/harness.mjs";

const SHARED = "198.51.100.99";
async function setup() {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" }), T = {};
  for (const [i, n] of ["owny", "ann", "bob"].entries()) T[n] = await c.player(n, "198.51.100." + (i + 10));
  const call = (a, b, who) => c.call(a, b, T[who], SHARED);
  const club = (await call("clubCreate", { name: "Pin Club", desc: "x" }, "owny")).body.club;
  await call("clubJoin", { id: club.id }, "ann");
  const op = (await call("opCreate", { club: club.id, title: "Sat open play", loc: "Riverside Courts", ts: Date.now() + 36e5, price: 0, cap: 12, courts: 2, rounds: 2 }, "owny")).body.od;
  assert.equal((await call("opJoin", { id: op.id }, "ann")).status, 200);
  return { call, club, op };
}

test("read markers live on the server: unread counts, seen clears them, state shows unread per open play", async () => {
  const { call, op } = await setup();
  for (const t of ["hi", "who is bringing balls?"]) assert.equal((await call("gcSend", { kind: "op", id: op.id, text: t }, "ann")).status, 200);
  let r = (await call("gcGet", { kind: "op", id: op.id }, "owny")).body;
  assert.equal(r.un, 2, "two messages from others are unread");
  assert.equal(r.lr, 0);
  assert.equal((await call("state", {}, "owny")).body.ops.find(x => x.id === op.id).un, 2, "the open play list shows it");
  assert.equal((await call("gcGet", { kind: "op", id: op.id }, "ann")).body.un, 0, "your own messages are never unread");
  r = (await call("gcGet", { kind: "op", id: op.id, seen: 1 }, "owny")).body;
  assert.equal(r.un, 0); assert.ok(r.lr > 0);
  r = (await call("gcGet", { kind: "op", id: op.id, since: r.lr }, "owny")).body;
  assert.equal(r.same, true); assert.equal(r.un, 0, "the marker stuck, even on a 'same' answer");
  assert.equal((await call("state", {}, "owny")).body.ops.find(x => x.id === op.id).un, 0);
  await call("gcSend", { kind: "op", id: op.id, text: "new one" }, "ann");
  assert.equal((await call("gcGet", { kind: "op", id: op.id }, "owny")).body.un, 1);
  assert.equal((await call("gcGet", { kind: "op", id: op.id }, "bob")).status, 403, "non-members still can't read");
});

test("pinned note: host only, 200 characters, shows for everyone, empty text unpins", async () => {
  const { call, op } = await setup();
  assert.equal((await call("gcPin", { kind: "op", id: op.id, text: "Bring balls" }, "ann")).status, 403, "players can't pin");
  assert.equal((await call("gcPin", { kind: "op", id: op.id, text: "x" }, "bob")).status, 403, "outsiders can't pin");
  let r = await call("gcPin", { kind: "op", id: op.id, text: "  " + "A".repeat(300) }, "owny");
  assert.equal(r.status, 200); assert.equal(r.body.pin.x.length, 200); assert.equal(r.body.pin.n, "owny");
  r = (await call("gcGet", { kind: "op", id: op.id }, "ann")).body;
  assert.equal(r.pin.x.length, 200, "players see it");
  assert.equal((await call("gcGet", { kind: "op", id: op.id, since: Date.now() + 1e5 }, "ann")).body.pin.x.length, 200, "a 'same' answer carries it too");
  assert.equal((await call("gcPin", { kind: "op", id: op.id, text: "" }, "owny")).body.pin, null);
  assert.equal((await call("gcGet", { kind: "op", id: op.id }, "ann")).body.pin, null);
});

test("club pin is for the owner; pinning is rate limited", async () => {
  const { call, club } = await setup();
  assert.equal((await call("gcPin", { kind: "club", id: club.id, text: "Rules: be kind" }, "ann")).status, 403, "members can't pin");
  assert.equal((await call("gcPin", { kind: "club", id: club.id, text: "Rules: be kind" }, "owny")).status, 200);
  assert.equal((await call("gcGet", { kind: "club", id: club.id }, "ann")).body.pin.x, "Rules: be kind");
  let last = 200;
  for (let i = 0; i < 12 && last === 200; i++) last = (await call("gcPin", { kind: "club", id: club.id, text: "n" + i }, "owny")).status;
  assert.equal(last, 429, "pin edits are limited per minute");
});
