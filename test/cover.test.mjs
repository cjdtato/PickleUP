// Cover photos: any player or coach can set their own; club owners (and admin) set a club's. Public read, version-cached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh } from "./helpers/harness.mjs";

const NAMES = ["owny", "ann", "coachy"], SHARED = "198.51.100.99";
const JPG = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");
async function setup() {
  const c = await fresh({ ADMIN_PASSWORD: "x-admin-pw" }), T = {}, ID = {};
  for (const [i, n] of NAMES.entries()) { T[n] = await c.player(n, "198.51.100." + (i + 10)); ID[n] = (await c.call("state", {}, T[n], SHARED)).body.me.id; }
  T.admin = (await c.call("login", { username: "admin", password: "x-admin-pw" }, "", SHARED)).body.token;
  const call = (a, b, who) => c.call(a, b, T[who], SHARED);
  assert.equal((await call("setRole", { id: ID.coachy, role: "certified_coach" }, "admin")).status, 200);
  const get = async q => c.mod.default(new Request("http://x/api?" + q), { ip: SHARED });
  return { c, T, ID, call, get };
}

test("a player and a coach can each set, read and remove their own cover photo", async () => {
  const { call, get, ID } = await setup();
  for (const who of ["ann", "coachy"]) {
    const r = await call("setCover", { img: JPG }, who);
    assert.equal(r.status, 200);
    assert.ok(r.body.me.cv, "the cover version is on the player's own state");
    const img = await get("cover=" + who);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/jpeg");
    assert.equal(Buffer.from(await img.arrayBuffer()).toString("hex"), "ffd8ffe001020304");
    assert.match(img.headers.get("cache-control"), /immutable/);
  }
  const p = (await call("profile", { id: ID.coachy }, "ann")).body.profile;
  assert.ok(p.cv, "other players see that a cover photo exists on the profile");
  assert.equal((await call("removeCover", {}, "ann")).body.me.cv, undefined);
  assert.equal((await get("cover=ann")).status, 404, "removed covers are gone");
  assert.equal((await get("cover=coachy")).status, 200, "removing one doesn't touch another");
});

test("cover photos only accept real image data URLs of a sane size", async () => {
  const { call } = await setup();
  assert.equal((await call("setCover", { img: "hello" }, "ann")).status, 400);
  assert.equal((await call("setCover", { img: "data:image/svg+xml;base64,PHN2Zz4=" }, "ann")).status, 400, "no SVG");
  assert.equal((await call("setCover", { img: "data:image/jpeg;base64," + "A".repeat(300001) }, "ann")).status, 400, "too large");
  assert.equal((await call("setCover", { img: JPG }, "ann")).status, 200);
});

test("a disabled player's cover photo is no longer served", async () => {
  const { call, get, ID } = await setup();
  await call("setCover", { img: JPG }, "ann");
  assert.equal((await call("setDisabled", { id: ID.ann, disabled: true }, "admin")).status, 200);
  assert.equal((await get("cover=ann")).status, 404);
});

test("only the club owner (or admin) can change a club's cover photo", async () => {
  const { call, get } = await setup();
  const club = (await call("clubCreate", { name: "Riverside Dinkers" }, "owny")).body.club;
  assert.equal((await call("clubSetCover", { id: club.id, img: JPG }, "ann")).status, 403, "other players can't");
  assert.equal((await call("clubSetCover", { id: club.id, img: "nope" }, "owny")).status, 400);
  const r = await call("clubSetCover", { id: club.id, img: JPG }, "owny");
  assert.equal(r.status, 200);
  assert.ok(r.body.club.cv, "club detail carries the cover version");
  const img = await get("clubcover=" + club.id);
  assert.equal(img.status, 200);
  assert.equal(Buffer.from(await img.arrayBuffer()).toString("hex"), "ffd8ffe001020304");
  assert.equal((await call("clubRemoveCover", { id: club.id }, "ann")).status, 403);
  assert.equal((await call("clubSetCover", { id: club.id, img: JPG }, "admin")).status, 200, "admin can too");
  assert.equal((await call("clubRemoveCover", { id: club.id }, "owny")).body.club.cv, undefined);
  assert.equal((await get("clubcover=" + club.id)).status, 404);
});

test("deleting a club deletes its cover photo, and saving club details keeps it", async () => {
  const { call, get } = await setup();
  const club = (await call("clubCreate", { name: "Net Ninjas" }, "owny")).body.club;
  await call("clubSetCover", { id: club.id, img: JPG }, "owny");
  const saved = await call("clubUpdate", { id: club.id, desc: "New blurb" }, "owny");
  assert.ok(saved.body.club.cv, "an edit that doesn't mention the cover leaves it alone");
  assert.equal((await call("clubDelete", { id: club.id }, "owny")).status, 200);
  assert.equal((await get("clubcover=" + club.id)).status, 404);
});
