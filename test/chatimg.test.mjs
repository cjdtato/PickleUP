// v8.21: photos in open play chat (not clubs or friends), own blob, cleaned up when trimmed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh } from "./helpers/harness.mjs";

const SHARED = "198.51.100.98", PNG = "data:image/png;base64,iVBORw0KGgo=";
test("open play photo: stored, served, validated, members only, open play only", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" }), T = {};
  for (const [i, n] of ["owny", "ann", "zed"].entries()) T[n] = await c.player(n, "198.51.100." + (i + 20));
  const call = (a, b, who) => c.call(a, b, T[who], SHARED);
  const club = (await call("clubCreate", { name: "Pic Club", desc: "x" }, "owny")).body.club;
  await call("clubJoin", { id: club.id }, "ann");
  const op = (await call("opCreate", { club: club.id, title: "Sat", loc: "Courts", ts: Date.now() + 36e5, price: 0, cap: 12, courts: 2, rounds: 2 }, "owny")).body.od;
  await call("opJoin", { id: op.id }, "ann");
  const r = await call("gcSend", { kind: "op", id: op.id, text: "", img: PNG }, "ann");
  assert.equal(r.status, 200); const m = r.body.msgs.at(-1);
  assert.match(m.im, /^[a-f0-9]{24}$/); assert.equal(m.x, "");
  const g = await c.mod.default(new Request("http://x/api?chatimg=" + m.im), { ip: SHARED });
  assert.equal(g.status, 200); assert.equal(g.headers.get("content-type"), "image/png");
  assert.equal((await c.mod.default(new Request("http://x/api?chatimg=nothex"), { ip: SHARED })).status, 404);
  assert.equal((await call("gcSend", { kind: "op", id: op.id, text: "x", img: "data:text/html;base64,AAAA" }, "ann")).status, 400, "only images");
  assert.equal((await call("gcSend", { kind: "op", id: op.id, text: "x", img: "data:image/png;base64," + "A".repeat(230000) }, "ann")).status, 400, "too big");
  assert.equal((await call("gcSend", { kind: "op", id: op.id, text: "", img: PNG }, "zed")).status, 403, "non-member can't post");
  assert.equal((await call("gcSend", { kind: "club", id: club.id, text: "", img: PNG }, "owny")).status, 400, "no photos in club chat");
  assert.equal((await call("gcSend", { kind: "op", id: op.id, text: "" }, "ann")).status, 400, "empty still refused");
});
