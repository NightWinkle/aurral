import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { db } from "../../backend/config/db-sqlite.js";
import { dbOps, userOps } from "../../backend/db/helpers/index.js";
import { createSession } from "../../backend/config/session-helpers.js";
import { authMiddleware } from "../../backend/middleware/auth.js";
import { buildPublicLibrary, registerLibraryIndex } from "../../backend/routes/library/handlers/libraryIndex.js";
import {
  upsertLibraryArtist, upsertLibraryAlbum, upsertLibraryTrack, upsertLibraryMediaFile,
} from "../../backend/services/libraryMediaStore.js";

const root = await mkdtemp(path.join(tmpdir(), "aurral-album-artwork-"));
const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } })
  .png().toBuffer();
const artist = upsertLibraryArtist({ identityKey: "artwork-artist", name: "Artwork Artist" });
const user = userOps.createUser("artwork-test-user", "unused-hash", "user");
const session = createSession(user.id);
dbOps.updateSettings({ onboardingComplete: true });

function audioWithPicture(picture) {
  const audio = Buffer.alloc(417 * 2);
  audio.set([0xff, 0xfb, 0x90, 0x64], 0);
  audio.set([0xff, 0xfb, 0x90, 0x64], 417);
  if (!picture) return audio;
  const payload = Buffer.concat([Buffer.from("\0image/png\0\x03\0", "binary"), picture]);
  const frame = Buffer.alloc(10);
  frame.write("APIC");
  frame.writeUInt32BE(payload.length, 4);
  const size = frame.length + payload.length;
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0,
    (size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f]);
  return Buffer.concat([header, frame, payload, audio]);
}

async function albumFixture(name, pictures) {
  const folder = path.join(root, name);
  await mkdir(folder);
  const album = upsertLibraryAlbum({ identityKey: name, artistId: artist.id, title: name });
  for (const [index, picture] of pictures.entries()) {
    const filePath = path.join(folder, `${String(index).padStart(3, "0")}.mp3`);
    await writeFile(filePath, audioWithPicture(picture));
    const track = upsertLibraryTrack({ identityKey: `${name}:${index}`, title: `${index}` });
    upsertLibraryMediaFile({ trackId: track.id, albumId: album.id, source: "aurral", path: filePath, available: true });
  }
  return { ...album, folder };
}

function routes() {
  const result = new Map();
  registerLibraryIndex({ get(route, ...handlers) { result.set(route, handlers); }, post() {} });
  return result;
}

async function requestCover(albumId, token = session.token, headers = {}) {
  const handlers = routes().get("/albums/:albumId/cover");
  assert.ok(handlers, "local album cover route must exist");
  const response = {
    statusCode: 200, headers: {},
    status(value) { this.statusCode = value; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; return this; },
    json(value) { this.body = value; return this; },
  };
  const req = { params: { albumId: String(albumId) }, query: token ? { token } : {},
    method: "GET", headers, path: `/api/library/albums/${albumId}/cover` };
  for (const handler of [authMiddleware, ...handlers]) {
    let continued = false;
    await handler(req, response, () => { continued = true; });
    if (!continued) break;
  }
  return response;
}

test.after(async () => {
  db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
  await rm(root, { recursive: true, force: true });
});

test("only available unidentified albums gain a local cover URL and remote artwork stays preferred", () => {
  const albums = buildPublicLibrary({ artists: [], tracks: [], albums: [
    { id: 12, available: true },
    { id: 13, available: true, coverUrl: "/existing-cover.webp" },
    { id: 14, available: false },
    { id: 15, available: true, releaseGroupMbid: "release-group" },
    { id: 16, available: true, mbid: "release" },
    { id: 17, available: true, metadata: { images: [{ remoteUrl: "https://example.invalid/cover.jpg" }] } },
  ] }).albums;
  assert.equal(albums[0].coverUrl, "/api/library/albums/12/cover");
  assert.equal(albums[1].coverUrl, "/existing-cover.webp");
  assert.equal(albums[2].coverUrl, null);
  assert.equal(albums[3].coverUrl, null);
  assert.equal(albums[4].coverUrl, null);
  assert.equal(albums[5].coverUrl, "https://example.invalid/cover.jpg");
});

test("cover endpoint finds embedded artwork on a later indexed track and returns private WebP", async () => {
  const album = await albumFixture("embedded", [null, image]);
  const result = await requestCover(album.id);
  assert.equal(result.statusCode, 200);
  assert.equal(result.contentType, "image/webp");
  const metadata = await sharp(result.body).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 16);
  assert.match(result.headers["Cache-Control"], /private/);
});

test("cover endpoint reads an album sidecar and resizes it to fit 512 pixels", async () => {
  const album = await albumFixture("sidecar", [null]);
  await sharp({ create: { width: 1024, height: 768, channels: 3, background: "blue" } })
    .png().toFile(path.join(album.folder, "cover.jpg"));
  const result = await requestCover(album.id);
  assert.equal(result.statusCode, 200);
  const metadata = await sharp(result.body).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 384);
});

test("cover endpoint refuses unknown albums, external sidecars and anonymous or invalid tokens", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  assert.equal((await requestCover("../etc/passwd", null, { authorization: `Bearer ${session.token}` })).statusCode, 404);
  assert.equal((await requestCover(999999)).statusCode, 404);
  const album = await albumFixture("symlink", [null]);
  const outside = path.join(root, "private.png");
  await writeFile(outside, image);
  await symlink(outside, path.join(album.folder, "cover.jpg"));
  assert.equal((await requestCover(album.id)).statusCode, 404);
  assert.equal((await requestCover(album.id, null)).statusCode, 401);
  assert.equal((await requestCover(album.id, "invalid-token")).statusCode, 401);
  await writeFile(path.join(album.folder, "folder.png"), image);
  t.mock.timers.tick(60_001);
  assert.equal((await requestCover(album.id, null, { authorization: `Bearer ${session.token}` })).statusCode, 200);
});

test("invalid images and sidecars exceeding byte or pixel limits are skipped for a later valid cover", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const album = await albumFixture("invalid", [null]);
  await writeFile(path.join(album.folder, "cover.jpg"), "invalid image");
  const oversized = path.join(album.folder, "cover.png");
  await writeFile(oversized, image);
  await truncate(oversized, 25 * 1024 * 1024 + 1);
  assert.equal((await requestCover(album.id)).statusCode, 404);
  await truncate(oversized, 25 * 1024 * 1024);
  t.mock.timers.tick(60_001);
  assert.equal((await requestCover(album.id)).statusCode, 200);
  await rm(oversized);
  await sharp({ create: { width: 8001, height: 5000, channels: 3, background: "red" } })
    .png().toFile(path.join(album.folder, "folder.jpg"));
  assert.equal((await requestCover(album.id)).statusCode, 404);
  await writeFile(path.join(album.folder, "folder.png"), image);
  t.mock.timers.tick(60_001);
  assert.equal((await requestCover(album.id)).statusCode, 200);
});

test("cover endpoint rejects expired sessions and disabled user accounts", async () => {
  const album = await albumFixture("session", [image]);
  const expired = createSession(user.id);
  db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(Date.now() - 1, expired.token);
  assert.equal((await requestCover(album.id, expired.token)).statusCode, 401);
  const disabled = userOps.createUser("disabled-artwork-user", "unused-hash", "user");
  try {
    const disabledSession = createSession(disabled.id);
    userOps.updateUser(disabled.id, { status: "disabled" });
    assert.equal((await requestCover(album.id, disabledSession.token)).statusCode, 401);
  } finally {
    db.prepare("DELETE FROM users WHERE id = ?").run(disabled.id);
  }
});

test("cover scan ignores unavailable files and inspects at most 100 indexed files", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const unavailable = await albumFixture("unavailable", [image]);
  db.prepare("UPDATE library_media_files SET available = 0 WHERE album_id = ?").run(unavailable.id);
  assert.equal((await requestCover(unavailable.id)).statusCode, 404);
  const bounded = await albumFixture("bounded", [...Array(100).fill(null), image]);
  assert.equal((await requestCover(bounded.id)).statusCode, 404);
  await writeFile(path.join(bounded.folder, "099.mp3"), audioWithPicture(image));
  t.mock.timers.tick(60_001);
  assert.equal((await requestCover(bounded.id)).statusCode, 200);
});

test("missing artwork is cached briefly and newly added artwork becomes visible after expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const album = await albumFixture("missing-artwork-cache", [null]);
  const missing = await requestCover(album.id);
  assert.equal(missing.statusCode, 404);
  await writeFile(path.join(album.folder, "cover.png"), image);

  assert.equal((await requestCover(album.id)).statusCode, 404);
  t.mock.timers.tick(60_001);
  assert.equal((await requestCover(album.id)).statusCode, 200);
});
