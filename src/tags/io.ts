/** Reading and writing audio files. The only place that opens a music file. */
import path from 'node:path';
import { File as TagFile } from 'node-taglib-sharp';
import type { AudioFormat, TagKind, TrackTags } from '../core/types.ts';
import { accessFor, ensureNativeTag, EXTENSION_FORMATS, UNSUPPORTED_EXTENSIONS } from './formats.ts';
import { isValidMbid } from '../core/iso.ts';

/** A tag value longer than this is not metadata, it is a payload. Ignore it. */
const MAX_TAG_LENGTH = 4096;

export function formatForPath(filePath: string): AudioFormat | null {
  return EXTENSION_FORMATS[path.extname(filePath).toLowerCase()] ?? null;
}

export function isUnsupportedAudio(filePath: string): boolean {
  return UNSUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TAG_LENGTH) return null;
  return trimmed;
}

/** An MBID out of a file is untrusted input; only well-formed ones survive. */
function cleanMbid(value: string | null | undefined): string | null {
  const trimmed = clean(value);
  return isValidMbid(trimmed) ? trimmed : null;
}

function withFile<T>(filePath: string, fn: (file: TagFile) => T): T {
  const file = TagFile.createFromPath(filePath);
  try {
    return fn(file);
  } finally {
    file.dispose();
  }
}

/** Read everything we need from one file. Opens read-only; never saves. */
export function readTrack(filePath: string): TrackTags {
  const format = formatForPath(filePath);
  if (!format) throw new Error(`unsupported extension: ${filePath}`);
  const access = accessFor(format);

  return withFile(filePath, (file) => {
    const tag = file.tag;
    return {
      path: filePath,
      format,
      title: clean(tag.title),
      artist: clean(tag.firstPerformer),
      albumArtist: clean(tag.firstAlbumArtist),
      album: clean(tag.album),
      genres: (tag.genres ?? []).map((g) => clean(g)).filter((g): g is string => g !== null),
      // taglib already knows how each format stores these, so we don't re-map them.
      artistMbid: cleanMbid(tag.musicBrainzArtistId),
      albumArtistMbid: cleanMbid(tag.musicBrainzReleaseArtistId),
      // Picard's `musicbrainz_trackid` holds the RECORDING id, which is what we want.
      recordingMbid: cleanMbid(tag.musicBrainzTrackId),
      existingCountry: clean(access.read(file, 'country')),
      existingLanguage: clean(access.read(file, 'language')),
    };
  });
}

/** Read just one field back — used to verify a write actually landed. */
export function readField(filePath: string, kind: TagKind): string | null {
  const format = formatForPath(filePath);
  if (!format) throw new Error(`unsupported extension: ${filePath}`);
  return withFile(filePath, (file) => clean(accessFor(format).read(file, kind)));
}

/**
 * Write one field and prove it stuck.
 *
 * Throws if the value does not read back, so a silent format-specific failure can never
 * be mistaken for a successful tagging run.
 */
export function writeField(filePath: string, kind: TagKind, value: string): void {
  const format = formatForPath(filePath);
  if (!format) throw new Error(`unsupported extension: ${filePath}`);

  withFile(filePath, (file) => {
    ensureNativeTag(file, format);
    accessFor(format).write(file, kind, value);
    file.save();
  });

  const readBack = readField(filePath, kind);
  if (readBack !== value) {
    throw new Error(
      `wrote ${kind}=${value} to ${filePath} but read back ${JSON.stringify(readBack)}`,
    );
  }
}

/** Remove a field entirely — used by undo when the field did not exist before. */
export function clearField(filePath: string, kind: TagKind): void {
  const format = formatForPath(filePath);
  if (!format) throw new Error(`unsupported extension: ${filePath}`);

  withFile(filePath, (file) => {
    accessFor(format).clear(file, kind);
    file.save();
  });
}
