# Babeltag — project rules

A CLI that tags a music library with artist country and song language so Navidrome smart
playlists can split it into shows. Read [CONTRACT.md](CONTRACT.md) before changing behaviour —
every invariant there is locked by a named test.

## Non-negotiables

- **NEVER write to a music file outside `apply`/`undo`.** `scan` is read-only and a test
  compares full file bytes to prove it. That read-only guarantee is the whole safety model.
- **ALWAYS journal before writing.** `journal.record()` then `writeField()`, in that order,
  flushed per file. A journal entry with no matching change is harmless; a change with no
  journal entry is unrecoverable.
- **NEVER guess a value into a file.** Every resolution carries a confidence, and `none` is a
  legitimate, common answer. A confidently wrong `deu` across a library is worse than a blank.
- **NEVER let a test touch the live MusicBrainz API.** Inject `fetchImpl`. It is a free service
  run by a non-profit, and a CI matrix hammering it is exactly how a client gets IP-banned.

## Stack

- Node 20+, TypeScript, ESM. **One** runtime dependency: `node-taglib-sharp` (pinned exact).
- Cache, CLI parsing, and tests come from Node itself — `node:util parseArgs`, `node:test`,
  plain JSONL files. Adding a dependency needs a real justification.

## Layout

| Path | Holds |
|---|---|
| [src/cli.ts](src/cli.ts) | Arg parsing, command dispatch, all console output |
| [src/commands/](src/commands) | One file per command: scan, apply, undo, playlists |
| [src/core/](src/core) | Pure logic — ISO codes, script detection, the resolution ladder, write policy |
| [src/tags/](src/tags) | The only code that opens an audio file |
| [src/mb/](src/mb) | MusicBrainz client, rate limiter, lookups, cache |
| [src/lib/](src/lib) | Filesystem plumbing — walk, journal, lock, paths |
| [src/navidrome.ts](src/navidrome.ts) | `.nsp` playlists and the `navidrome.toml` snippet |

## Things that will bite you

- **`artist:Yorushika` returns ZERO results.** The fielded MusicBrainz query searches only an
  artist's primary name, and ヨルシカ stores `Yorushika` as an alias. Plain `Yorushika` returns
  it at score 100. **ALWAYS use a plain default-field query** — every non-Latin artist in a
  user's library depends on it. Locked by contract R2.
- **Country MUST resolve before language.** Shared-script disambiguation (Arabic → Persian vs
  Urdu, Cyrillic → Russian vs Ukrainian, bare kanji → Japanese vs Chinese) reads the resolved
  country. Reordering these silently degrades those languages to unresolved. Locked by R1.
- **Navidrome does NOT normalise tag keys across formats.** Its `mappings.yaml` lists every raw
  per-format spelling separately (`tlan`, `language`, `----:com.apple.itunes:language`). If you
  add a tag, add every per-format alias to `navidromeAliases()` or the tag is written perfectly
  and then silently ignored.
- **Navidrome needs a FULL scan after a tag-config change.** A quick scan will not pick it up.
  This is the single most common way a user ends up with nothing, so the CLI says so in its own
  output — do not remove that line.
- **Check kana before Han.** A Japanese title mixing kanji and kana must not fall through to
  the ambiguous Han branch. The `DEFINITE` list in [src/core/script.ts](src/core/script.ts) is
  order-sensitive; kana comes first for this reason.
- **A transient MusicBrainz failure must NEVER be cached.** Caching a 503 as "no such artist"
  poisons every future run. `#tryLookup` catches outside the cache write — keep it that way.
- **`erasableSyntaxOnly` is on.** No parameter properties (`constructor(readonly x: T)`), no
  enums, no namespaces. The tests run TypeScript directly via Node's type stripping, which
  rejects all of them at runtime even though `tsc` would accept them.
- **NEVER write to `test/fixtures/`.** Tests must copy a fixture to a temp dir first
  (`copyFixture`). A polluted fixture produces failures in unrelated tests that look like real
  bugs — this has already happened once.
- **taglib splits its API.** MusicBrainz IDs come from the combined `file.tag` (it already
  knows every format's convention); custom fields need the format-specific tag object. Do not
  hand-roll per-format MBID mapping — it was written once and deleted as duplicated work.

## Testing

- `npm test` — 113 tests, no network, no ffmpeg required.
- **Node 22+ is required to RUN the tests** (type stripping). The published package ships
  compiled JS and supports Node 20; CI checks that separately.
- The audio-integrity test uses ffmpeg when present and skips itself cleanly when not.
- Fixtures are committed on purpose so the suite runs anywhere. Regenerate with:
  `ffmpeg -f lavfi -i "anullsrc=r=44100:cl=mono" -t 1 -q:a 9 silence.<ext>`
- Add a test for every contract invariant you touch, and update the mapping table in
  [CONTRACT.md](CONTRACT.md).

## Working on resolution

- The ladder lives in [src/core/resolve.ts](src/core/resolve.ts) and is deliberately ordered
  for cost as well as accuracy: script detection is free and conclusive for kana/Hangul/Hebrew,
  so the common case needs almost no network. At one request per second, per-track lookups on a
  20k library are ~5.5 hours.
- `--language-source musicbrainz` inverts the order for users who want maximum accuracy over
  speed. Keep both paths working.
- Adding a language to a shared script means adding a country → language entry, never a
  default. "Most Arabic-script music is Arabic" is exactly the assumption that mis-tags every
  Persian and Urdu track.

## Documentation

| File | For |
|---|---|
| `CLAUDE.md` (this file) | Rules an agent needs before changing anything |
| [CONTRACT.md](CONTRACT.md) | Every behavioural invariant, mapped to the test that locks it |
| [README.md](README.md) | The user-facing guide — install, commands, Navidrome setup |

When behaviour changes, update `CONTRACT.md` and its test in the same commit. When a rule here
stops being true, delete it — a stale rule an agent trusts is worse than no rule.
