// v8.23: weekly challenge, finish all 3 daily quests on 4 days of a Monday-to-Sunday week for a bonus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh } from "./helpers/harness.mjs";

test("weekly challenge: progress counts full days, can't be claimed early", async () => {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" });
  const t = await c.player("wkly", "198.51.100.41");
  let s = (await c.call("state", {}, t)).body;
  assert.equal(s.weekly.n, 0); assert.equal(s.weekly.need, 4); assert.equal(s.weekly.xp, 60);
  assert.equal((await c.call("claim", { qid: s.weekly.id }, t)).status, 400, "not enough days yet");
  for (const q of s.today) await c.ok("claim", { qid: q.id }, t);
  s = (await c.call("state", {}, t)).body;
  assert.equal(s.weekly.n, 1, "one full day counted");
  assert.equal((await c.call("claim", { qid: s.weekly.id }, t)).status, 400, "1 of 4 days");
  assert.equal((await c.call("claim", { qid: "w1" }, t)).status, 400, "wrong week id");
});
