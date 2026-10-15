import fs from "node:fs/promises";
import path from "node:path";
import { parseFile, selectCover } from "music-metadata";
import { db } from "../config/db-sqlite.js";
import getSharp from "./sharpConfig.js";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

async function renderCover(data) {
  const sharp = await getSharp();
  return sharp(data, { limitInputPixels: 40_000_000 })
    .rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 70 }).toBuffer();
}

export async function getLibraryAlbumArtwork(albumId) {
  if (!/^[1-9]\d*$/.test(String(albumId))) return null;
  // shortcut: inspect at most 100 indexed files; extend for box sets with artwork only on later discs.
  const files = db.prepare(`SELECT path FROM library_media_files
    WHERE album_id = ? AND available = 1 ORDER BY path COLLATE NOCASE LIMIT 100`).all(albumId);
  const checkedFolders = new Set();
  for (const file of files) {
    try {
      const metadata = await parseFile(file.path, { duration: false });
      const picture = selectCover(metadata.common.picture);
      if (picture?.data?.length && picture.data.length <= MAX_IMAGE_BYTES) {
        return await renderCover(picture.data);
      }
    } catch {
      // Try another indexed file if tags or embedded artwork are unreadable.
    }
    const folder = path.dirname(file.path);
    if (checkedFolders.has(folder)) continue;
    checkedFolders.add(folder);
    for (const name of ["cover.jpg", "cover.png", "folder.jpg", "folder.png"]) {
      try {
        const artworkPath = await fs.realpath(path.join(folder, name));
        if (path.dirname(artworkPath) !== await fs.realpath(folder)) continue;
        const stat = await fs.stat(artworkPath);
        if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) continue;
        return await renderCover(await fs.readFile(artworkPath));
      } catch {
        // Missing or invalid sidecars do not prevent trying embedded artwork.
      }
    }
  }
  return null;
}
