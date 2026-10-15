import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanMusicRoot } from "../../backend/services/libraryFileScanner.js";
import { getLibrary, getLibraryPage } from "../../backend/services/libraryQueryService.js";
import {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} from "../../backend/services/libraryMediaStore.js";

test("track performer stays distinct from the album owner without changing audio tags", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-performer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "Owner", "Album", "01.mp3");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "original audio");
  const common = { albumartist: "Owner", artist: "Guest & Owner", album: "Album", title: "Song" };

  await scanMusicRoot({ rootPath: root, metadataReader: async () => ({ common }) });

  const library = getLibrary({ availableOnly: true });
  const track = library.tracks.find((entry) => entry.files.some((entry) => entry.path === file));
  assert.equal(track.artistName, "Guest & Owner");
  assert.equal(library.albums.find((album) => album.trackIds.includes(track.id))?.albumArtist, "Owner");
  assert.equal(await readFile(file, "utf8"), "original audio");
});

test("rescanning updates a local title when its normalized identity stays the same", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-title-rescan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "Title Artist", "Title Album", "01.mp3");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "original audio");
  const common = { albumartist: "Title Artist", artist: "Title Artist", album: "Title Album", title: "Pret", track: { no: 1 } };
  const scan = () => scanMusicRoot({ rootPath: root, force: true,
    metadataReader: async () => ({ common }) });
  const readTrack = () => getLibrary({ availableOnly: true }).tracks
    .find((track) => track.files.some((entry) => entry.path === file));
  await scan();
  const before = readTrack();
  common.title = "Prêt";

  await scan();

  const after = readTrack();
  assert.equal(after.id, before.id);
  assert.equal(after.identityKey, before.identityKey);
  assert.equal(after.title, "Prêt");
  assert.equal(after.metadata.tags.title, "Prêt");
});

test("reused canonical tracks refresh performer tags without replacing identity", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-canonical-performer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "Canonical Owner", "Canonical Album", "01.mp3");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "original audio");
  const common = { albumartist: "Canonical Owner", artist: "Original Guest", album: "Canonical Album",
    title: "Prêt", track: { no: 1 }, musicbrainz_recordingid: "11111111-1111-4111-8111-111111111111" };
  const scan = () => scanMusicRoot({ rootPath: root, force: true,
    metadataReader: async () => ({ common }) });
  const readTrack = () => getLibrary({ availableOnly: true }).tracks
    .find((track) => track.files.some((entry) => entry.path === file));
  await scan();
  const before = readTrack();
  upsertLibraryTrack({ identityKey: before.identityKey, mbid: before.mbid, title: before.title,
    artistName: before.artistName, metadata: { ...before.metadata, canonicalSource: "catalogue" } });
  delete common.musicbrainz_recordingid;
  common.artist = "Corrected Guest";
  common.title = "Pret";

  await scan();

  const after = readTrack();
  assert.equal(after.id, before.id);
  assert.equal(after.identityKey, before.identityKey);
  assert.equal(after.mbid, "11111111-1111-4111-8111-111111111111");
  assert.equal(after.title, "Prêt");
  assert.equal(after.artistName, "Corrected Guest");
  assert.equal(after.metadata.tags.artist, "Corrected Guest");
  assert.equal(after.metadata.tags.title, "Pret");
  assert.equal(after.metadata.canonicalSource, "catalogue");
});

for (const scope of ["library", "album"]) {
  test(`${scope} track pages sort by performer before pagination, falling back to the album owner`, () => {
    const artist = upsertLibraryArtist({ identityKey: `sort:${scope}:artist`, name: "Sort Owner" });
    const album = upsertLibraryAlbum({ identityKey: `sort:${scope}:album`, artistId: artist.id, title: "Sort Album" });
    for (const [index, [title, artistName]] of [
      ["A guest song", "Guest"], ["Z alpha song", "Alpha"], ["M owner song", null],
    ].entries()) {
      const track = upsertLibraryTrack({ identityKey: `sort:${scope}:track:${index}`, title, artistName });
      linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: index + 1 });
      upsertLibraryMediaFile({ trackId: track.id, albumId: album.id, source: "aurral",
        path: `/fixture/sort-${scope}/${index}.flac`, available: true });
    }
    const filter = scope === "album" ? { albumId: album.id } : { artistId: artist.id };
    const titles = (direction) => [1, 2, 3].map((page) => getLibraryPage({ kind: "tracks",
      ...filter, sort: "artist", direction, page, pageSize: 1 }).items[0]?.title);

    assert.deepEqual(titles("asc"), ["Z alpha song", "A guest song", "M owner song"]);
    assert.deepEqual(titles("desc"), ["M owner song", "A guest song", "Z alpha song"]);
  });
}
