// Coach ratings: only after attendance, one per player per session, 7 day edit lock, average kept in sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, advance, DAY, HOUR } from "./helpers/harness.mjs";

const NAMES = ["ann", "bob", "coachy"], SHARED = "198.51.100.99";
async function setup() {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" }), T = {}, ID = {};
  for (const [i, n] of NAMES.entries()) { T[n] = await c.player(n, "198.51.100." + (i + 10)); ID[n] = (await c.call("state", {}, T[n], SHARED)).body.me.id; }
  T.admin = (await c.call("login", { username: "admin", password: "x-admin-pw" }, "", SHARED)).body.token;
  const call = (a, b, who) => c.call(a, b, T[who], SHARED);
  await call("setRole", { id: ID.coachy, role: "certified_coach" }, "admin");
  // one attended session per player
  const book = async who => {
    const ts = Date.now() + HOUR * (who === "ann" ? 1 : 2) + 6e4;
    const r = await call("addSession", { kind: "lesson", ts, title: "Dinks " + who, loc: "Court One", price: 0, cap: 2, dur: 60 }, "coachy");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sess = r.body.coach.sessions.find(x => x.title === "Dinks " + who);
    const bk = await call("book", { sessionId: sess.id }, who);
    assert.equal(bk.status, 200, JSON.stringify(bk.body));
    return bk.body.bookings.find(x => x.sid === sess.id).id;
  };
  const attend = id => call("attend", { id }, "coachy");
  return { c, T, ID, call, book, attend };
}

test("rating needs an attended booking, valid stars, and is one per session (edits allowed)", async () => {
  const { call, book, attend } = await setup();
  const id = await book("ann");
  assert.equal((await call("rateCoach", { id, stars: 5 }, "ann")).status, 403, "not attended yet");
  assert.equal((await attend(id)).status, 200);
  assert.equal((await call("rateCoach", { id, stars: 0 }, "ann")).status, 400);
  assert.equal((await call("rateCoach", { id, stars: 4.5 }, "ann")).status, 400);
  assert.equal((await call("rateCoach", { id, stars: 5 }, "bob")).status, 404, "someone else's booking");
  const r = await call("rateCoach", { id, stars: 5, text: "  Great  " }, "ann");
  assert.equal(r.status, 200);
  assert.equal(r.body.bookings.find(x => x.id === id).rt.text, "Great");
  assert.deepEqual(r.body.coach, undefined, "players don't get coach data");
  const e = await call("rateCoach", { id, stars: 3, text: "x".repeat(400) }, "ann");
  assert.equal(e.status, 200);
  const rv = (await call("coachReviews", {}, "coachy")).body;
  assert.equal(rv.rating.n, 1, "edit does not add a second rating");
  assert.equal(rv.rating.avg, 3);
  assert.equal(rv.reviews[0].text.length, 280);
});

test("ratings lock after 7 days; average and count follow create, edit, removal", async () => {
  const { call, book, attend } = await setup();
  const a = await book("ann"), b = await book("bob");
  advance(HOUR);
  assert.equal((await attend(a)).status, 200); assert.equal((await attend(b)).status, 200);
  await call("rateCoach", { id: a, stars: 5 }, "ann");
  const st = await call("rateCoach", { id: b, stars: 2, text: "meh" }, "bob");
  assert.deepEqual(st.status, 200);
  let co = (await call("state", {}, "coachy")).body.coach;
  assert.deepEqual(co.rating, { avg: 3.5, n: 2 });
  assert.equal(co.reviews.length, 2);
  // public view hides names; coach sees them
  const pub = (await call("coachReviews", { coach: co.reviews[0].id && (await call("state", {}, "coachy")).body.me.id }, "ann")).body;
  assert.ok(pub.reviews.every(x => x.pn === "A student"));
  assert.ok(co.reviews.some(x => x.pn === "bob"));
  // coach reports, admin removes
  const bad = co.reviews.find(x => x.pn === "bob");
  assert.equal((await call("reportReview", { id: bad.id }, "ann")).status, 403, "players can't report");
  assert.equal((await call("reportReview", { id: bad.id }, "coachy")).status, 200);
  assert.equal((await call("removeReview", { id: bad.id }, "coachy")).status, 403, "coach can't delete");
  const ad = (await call("state", {}, "admin")).body.admin;
  assert.equal(ad.rflags.length, 1);
  assert.equal((await call("removeReview", { id: bad.id }, "admin")).status, 200);
  co = (await call("state", {}, "coachy")).body.coach;
  assert.deepEqual(co.rating, { avg: 5, n: 1 });
  // lock
  advance(8 * DAY);
  assert.equal((await call("rateCoach", { id: a, stars: 1 }, "ann")).status, 403);
  assert.equal((await call("state", {}, "ann")).body.bookings.find(x => x.id === a).rt.lock, true);
});

test("coach screen shows session status: cancelled and ended sessions land in recent", async () => {
  const { call } = await setup();
  const mk = async (title, off) => (await call("addSession", { kind: "lesson", ts: Date.now() + off, title, loc: "Court One", price: 0, cap: 2, dur: 60 }, "coachy")).body.coach;
  await mk("Soon", HOUR);
  let co = await mk("Gone", 2 * HOUR);
  const gone = co.sessions.find(x => x.title === "Gone");
  assert.equal(gone.st, "open");
  const r = await call("cancelSession", { sid: gone.id }, "coachy");
  assert.equal(r.status, 200);
  co = (await call("state", {}, "coachy")).body.coach;
  assert.ok(!co.sessions.some(x => x.title === "Gone"), "cancelled leaves upcoming");
  const rec = co.recent.find(x => x.title === "Gone");
  assert.equal(rec.st, "cancelled");
  assert.ok(co.sessions.find(x => x.title === "Soon").st === "open");
});
