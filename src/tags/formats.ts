/**
 * Three tag systems hide behind five file extensions, and each spells a custom field
 * differently. Everything format-specific lives here.
 *
 * Scope note: taglib already knows how every format stores MusicBrainz IDs, so this file
 * only deals with the two genuinely custom fields — country and language.
 *
 * The written keys are not free choices. They are the exact strings Navidrome's
 * `mappings.yaml` matches on, and Navidrome does not normalise across formats — get these
 * wrong and the tags are written perfectly, then silently ignored.
 */
import { TagTypes, Id3v2FrameIdentifiers } from 'node-taglib-sharp';
import type { File as TagFile, Tag } from 'node-taglib-sharp';
import type { AudioFormat, TagKind } from '../core/types.ts';

export const ITUNES_MEAN = 'com.apple.iTunes';

/** Our tag names. `LANGUAGE` is a standard field Navidrome already understands. */
export const COUNTRY_TAG = 'ARTISTCOUNTRY';
export const LANGUAGE_TAG = 'LANGUAGE';

export const EXTENSION_FORMATS: Record<string, AudioFormat> = {
  '.flac': 'flac',
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.opus': 'opus',
  '.mp3': 'mp3',
  '.m4a': 'm4a',
  '.m4b': 'm4a',
  '.mp4': 'm4a',
};

/** Audio we recognise but cannot tag, so we can report it rather than skip in silence. */
export const UNSUPPORTED_EXTENSIONS = new Set(['.wma', '.aac', '.aiff', '.aif', '.ape', '.wv']);

function tagTypeFor(format: AudioFormat): number {
  if (format === 'mp3') return TagTypes.Id3v2;
  if (format === 'm4a') return TagTypes.Apple;
  return TagTypes.Xiph;
}

export interface FieldAccess {
  read(file: TagFile, kind: TagKind): string | null;
  write(file: TagFile, kind: TagKind, value: string): void;
  clear(file: TagFile, kind: TagKind): void;
}

// --- Xiph: FLAC, OGG, Opus -------------------------------------------------

interface XiphTag extends Tag {
  getField(key: string): string[];
  setFieldAsStrings(key: string, ...values: string[]): void;
}

const XIPH_KEY: Record<TagKind, string> = { country: COUNTRY_TAG, language: LANGUAGE_TAG };

const xiphAccess: FieldAccess = {
  read(file, kind) {
    const tag = file.getTag(TagTypes.Xiph, false) as XiphTag | undefined;
    if (!tag) return null;
    // Vorbis comments are case-insensitive by spec, but taglib matches exactly and
    // taggers disagree on case — so try both spellings.
    const key = XIPH_KEY[kind];
    for (const candidate of [key, key.toLowerCase()]) {
      const values = tag.getField(candidate);
      if (values?.length && values[0]) return values[0];
    }
    return null;
  },
  write(file, kind, value) {
    const tag = file.getTag(TagTypes.Xiph, true) as XiphTag;
    tag.setFieldAsStrings(XIPH_KEY[kind], value);
  },
  clear(file, kind) {
    const tag = file.getTag(TagTypes.Xiph, false) as XiphTag | undefined;
    if (!tag) return;
    const key = XIPH_KEY[kind];
    // Setting no values removes the field.
    tag.setFieldAsStrings(key);
    tag.setFieldAsStrings(key.toLowerCase());
  },
};

// --- ID3v2: MP3 ------------------------------------------------------------

interface Id3Tag extends Tag {
  setUserTextAsString(description: string, text: string | undefined): void;
  getUserTextAsString(description: string): string | undefined;
  setTextFrame(id: unknown, ...values: string[]): void;
  getTextAsString(id: unknown): string | undefined;
}

const id3Access: FieldAccess = {
  read(file, kind) {
    const tag = file.getTag(TagTypes.Id3v2, false) as Id3Tag | undefined;
    if (!tag) return null;
    if (kind === 'language') {
      // TLAN is the standard frame and what Navidrome reads first.
      return tag.getTextAsString(Id3v2FrameIdentifiers.TLAN) ?? tag.getUserTextAsString(LANGUAGE_TAG) ?? null;
    }
    return tag.getUserTextAsString(COUNTRY_TAG) ?? null;
  },
  write(file, kind, value) {
    const tag = file.getTag(TagTypes.Id3v2, true) as Id3Tag;
    if (kind === 'language') tag.setTextFrame(Id3v2FrameIdentifiers.TLAN, value);
    else tag.setUserTextAsString(COUNTRY_TAG, value);
  },
  clear(file, kind) {
    const tag = file.getTag(TagTypes.Id3v2, false) as Id3Tag | undefined;
    if (!tag) return;
    if (kind === 'language') {
      tag.setTextFrame(Id3v2FrameIdentifiers.TLAN);
      tag.setUserTextAsString(LANGUAGE_TAG, undefined);
    } else {
      tag.setUserTextAsString(COUNTRY_TAG, undefined);
    }
  },
};

// --- MP4 / iTunes: M4A -----------------------------------------------------

interface AppleTag extends Tag {
  setItunesStrings(mean: string, name: string, ...values: string[]): void;
  getFirstItunesString(mean: string, name: string): string | undefined;
}

/** Navidrome's built-in alias is the lowercase `language`; country is ours. */
const MP4_KEY: Record<TagKind, string> = { country: COUNTRY_TAG, language: 'language' };

const appleAccess: FieldAccess = {
  read(file, kind) {
    const tag = file.getTag(TagTypes.Apple, false) as AppleTag | undefined;
    return tag?.getFirstItunesString(ITUNES_MEAN, MP4_KEY[kind]) ?? null;
  },
  write(file, kind, value) {
    const tag = file.getTag(TagTypes.Apple, true) as AppleTag;
    tag.setItunesStrings(ITUNES_MEAN, MP4_KEY[kind], value);
  },
  clear(file, kind) {
    const tag = file.getTag(TagTypes.Apple, false) as AppleTag | undefined;
    tag?.setItunesStrings(ITUNES_MEAN, MP4_KEY[kind]);
  },
};

export function accessFor(format: AudioFormat): FieldAccess {
  if (format === 'mp3') return id3Access;
  if (format === 'm4a') return appleAccess;
  return xiphAccess;
}

/** Make sure the format's native tag exists before writing into it. */
export function ensureNativeTag(file: TagFile, format: AudioFormat): void {
  file.getTag(tagTypeFor(format), true);
}

/**
 * Every raw key Navidrome could see for a field, across all formats and both cases.
 * This is what the generated `navidrome.toml` snippet lists.
 */
export function navidromeAliases(kind: TagKind): string[] {
  const base = (kind === 'country' ? COUNTRY_TAG : LANGUAGE_TAG).toLowerCase();
  const aliases = new Set<string>([
    base,
    `txxx:${base}`,
    `----:${ITUNES_MEAN.toLowerCase()}:${base}`,
  ]);
  if (kind === 'language') aliases.add('tlan');
  return [...aliases];
}
