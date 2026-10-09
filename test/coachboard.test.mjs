// Top Rated Coaches: 5-rating minimum, order by average then count, top 10 plus own position, profile rating, #1 flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, advance, HOUR } from "./helpers/harness.mjs";

const SHARED = "198.51.100.99";
async function setup(coaches, students) {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" }), T = {}, ID = {};
  let i = 10;
  for (const n of [...coaches, ...students]) { T[n] = await c.player(n, "198.51.100." + i++); ID[n] = (await c.call("state", {}, T[n], SHARED)).body.me.id; }
  T.admin = (await c.call("login", { username: "admin", password: "x-admin-pw" }, "", SHARED)).body.token;
  const call = (a, b, who) => c.call(a, b, T[who], SHARED);
  for (const n of coaches) await call("setRole", { id: ID[n], role: "certified_coach" }, "admin");
  // student rates coach: book + attend + rate (each student attends its own session)
  const rate = async (coach, student, stars, k) => {
    const ts = Date.now() + 5 * 6e4;
    const r = await call("addSession", { kind: "lesson", ts, title: `L${coach}${student}${k}`, loc: "Court One", price: 0, cap: 2, dur: 10 }, coach);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sess = r.body.coach.sessions.find(x => x.title === `L${coach}${student}${k}`);
    const bk = (await call("book", { sessionId: sess.id }, student)).body.bookings.find(x => x.sid === sess.id).id;
    assert.equal((await call("attend", { id: bk }, coach)).status, 200);
    const rr = await call("rateCoach", { id: bk, stars }, student);
    assert.equal(rr.status, 200, JSON.stringify(rr.body));
    advance(HOUR); // next session never overlaps
  };
  return { call, ID, rate };
}

test("needs 5 ratings, orders by average then count, shows own position, profile and #1 flag", async () => {
  const students = ["stuone", "stutwo", "stuthree", "stufour", "stufive"];
  const { call, ID, rate } = await setup(["coacha", "coachb", "coachc"], students);
  // cA: five 5-star; cB: five ratings avg 4.0; cC: only four 5-star ratings (not ranked)
  for (const [k, s] of students.entries()) { await rate("coacha", s, 5, k); await rate("coachb", s, 4, k + 10); }
  for (const [k, s] of students.slice(0, 4).entries()) await rate("coachc", s, 5, k + 20);
  const b = (await call("coachBoard", {}, "stuone")).body;
  assert.equal(b.min, 5);
  assert.deepEqual(b.top.map(x => x.n), ["coacha", "coachb"], "cC has only 4 ratings");
  assert.equal(b.top[0].rank, 1);
  assert.equal(b.me, null, "students have no coach position");
  const bc = (await call("coachBoard", {}, "coachc")).body;
  assert.equal(bc.me.rank, null);
  assert.equal(bc.me.need, 1);
  assert.equal((await call("coachBoard", {}, "coachb")).body.me.rank, 2);
  // profile: rating and #1 only for coaches
  const pa = (await call("profile", { id: ID.coacha }, "stuone")).body.profile, pb = (await call("profile", { id: ID.coachb }, "stuone")).body.profile, ps = (await call("profile", { id: ID.stuone }, "stutwo")).body.profile;
  assert.equal(pa.rating.n, 5); assert.equal(pa.rating.avg, 5); assert.equal(pa.top1, true);
  assert.equal(pb.top1, undefined);
  assert.equal(ps.rating, undefined); assert.equal(ps.top1, undefined);
  // a fifth rating for cC puts them second on count tie-break? cC avg 5 ties cA: more ratings wins
  await rate("coachc", "stufive", 5, 30);
  const b2 = (await call("coachBoard", {}, "stuone")).body;
  assert.deepEqual(b2.top.map(x => x.n), ["coacha", "coachc", "coachb"], "cA and cC tie on 5.0 and 5 ratings: older account first");
});
