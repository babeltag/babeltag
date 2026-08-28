# Babeltag — behaviour contract

Every invariant here is locked by a named test. Change the behaviour and the test must change
with it, deliberately.

## S — Safety (writes to irreplaceable files)

| # | Invariant | Locked by |
|---|---|---|
| S1 | `scan` never modifies an audio file | `tags.test.ts` — *reading a file does not modify it* |
| S2 | Tagging leaves the decoded audio stream byte-identical | `tags.test.ts` — *tagging leaves the decoded audio stream byte-identical*; `safety.test.ts` — *apply writes, undo restores, and the audio never changes* |
| S3 | Every write is journalled **before** the file is touched, and flushed per file | `safety.test.ts` — *an interrupted run is still fully undoable* |
| S4 | `undo` restores exactly, including removing a field that did not exist | `safety.test.ts` — *apply writes, undo restores…* / *undo puts back a previous value rather than deleting it* |
| S5 | An existing non-empty value is never overwritten without `--overwrite` | `core.test.ts` — *an existing value is never clobbered without --overwrite*; `safety.test.ts` — *apply refuses to overwrite an existing value by default* |
| S6 | Every write is read back and verified; a mismatch throws | `tags/io.ts#writeField`; `tags.test.ts` — *every supported format round-trips both tags* |
| S7 | `apply` is idempotent — a second run writes nothing | `safety.test.ts` — *apply is idempotent* |
| S8 | Two runs cannot tag one library at once; a crash never leaves it locked | `safety.test.ts` — *a second run cannot tag a library…* / *the lock is released even when the work throws* |
| S9 | A tag value containing newlines cannot corrupt the journal | `safety.test.ts` — *a tag value containing a newline cannot corrupt the journal* |

## R — Resolution (never guess silently)

| # | Invariant | Locked by |
|---|---|---|
| R1 | Country is resolved **before** language; shared-script disambiguation depends on it | `commands/scan.ts`; `core.test.ts` — *a shared script is narrowed by the country resolved first* |
| R2 | Artist search uses a **plain** query, never the fielded `artist:` form, so alias-only artists resolve | `musicbrainz.test.ts` — *search uses a plain query, so it finds an artist by a Latin alias* |
| R3 | A search hit is accepted only at score ≥ 95, ≥ 5 clear of the runner-up, and of an acceptable type | `musicbrainz.test.ts` — *search refuses an ambiguous name* / *search refuses a weak match* |
| R4 | A definite script settles the language with no network call | `core.test.ts` — *a definite script short-circuits MusicBrainz entirely* |
| R5 | Any definite script beats Latin in a mixed title | `core.test.ts` — *a mixed Latin/Japanese title resolves as Japanese* / *kana beats the shared Han branch* |
| R6 | A shared script (Arabic, Cyrillic, Han, Devanagari) is never resolved without a country | `core.test.ts` — *a shared script needs the country and refuses to guess without it* |
| R7 | A Latin-script title with no MusicBrainz data stays `unknown` — never a guess | `core.test.ts` — *a Latin title with no MusicBrainz data stays honestly unknown* |
| R8 | An instrumental resolves to `zxx`, from either the relation attribute or the work language | `musicbrainz.test.ts` — *an instrumental attribute becomes zxx* / *a zxx work language is recognised* |
| R9 | Compilations ("Various Artists" etc.) are skipped, not given a nonsense country | `core.test.ts` — *compilations are skipped rather than given a nonsense country* |
| R10 | Below-confidence and unresolved values are never written | `core.test.ts` — *the confidence gate keeps weak guesses out of files* / *an unresolved value is never written at any confidence* |

## N — Network citizenship

| # | Invariant | Locked by |
|---|---|---|
| N1 | At most one request per second, strictly serialised | `musicbrainz.test.ts` — *limiter keeps requests one second apart using a fake clock* |
| N2 | A real User-Agent is always sent | `musicbrainz.test.ts` — *client sends a real User-Agent and asks for JSON* |
| N3 | `Retry-After` is honoured; 5xx/429 retried, 404 not | `musicbrainz.test.ts` — *client honours Retry-After* / *client gives up on a 404 immediately* |
| N4 | Repeat lookups cost no HTTP calls | `musicbrainz.test.ts` — *cache prevents repeat HTTP calls* |
| N5 | A transient failure degrades to unresolved and is **never cached** | `core.test.ts` — *a MusicBrainz outage degrades to unresolved…* / *a transient failure is never cached as a negative answer* |
| N6 | No test ever touches the live MusicBrainz API | every test injects `fetchImpl` |

## I — Input safety

| # | Invariant | Locked by |
|---|---|---|
| I1 | A MusicBrainz ID read from a file is validated as a UUID before reaching a URL | `core.test.ts` — *only a well-formed UUID counts*; `musicbrainz.test.ts` — *a malformed MBID never reaches the network*; `tags.test.ts` — *a real MusicBrainz id is read back, a malformed one is rejected* |
| I2 | Symlinks are not followed when walking a library | `lib/walk.ts` |
| I3 | Dot-directories are skipped, so the tool never scans its own state | `safety.test.ts` — *walk skips dot-directories* |
| I4 | An unreadable file is reported, never fatal to the run | `commands/scan.ts`; `safety.test.ts` — *apply tolerates a file that vanished after the scan* |
| I5 | `apply` refuses any plan entry resolving outside the library root | `safety.test.ts` — *apply refuses plan entries pointing outside the library* |

## V — Navidrome interoperability

| # | Invariant | Locked by |
|---|---|---|
| V1 | Written keys match Navidrome's documented aliases on every format | `tags.test.ts` — *navidrome aliases cover every per-format key it could see* |
| V2 | The generated snippet lists every per-format alias and demands a FULL scan | `navidrome.test.ts` — *the config snippet lists every per-format key* |
| V3 | Language requires **no** Navidrome configuration; country requires the snippet | Verified against Navidrome v0.63.2 — see below |
| V4 | Generated `.nsp` files are valid JSON in Navidrome's documented shape | `navidrome.test.ts` — *a playlist matches the documented Navidrome smart-playlist shape* / *generate writes one playlist per value* |
| V5 | Playlist filenames are safe on any filesystem | `navidrome.test.ts` — *playlist filenames are safe on any filesystem* |

### V3 — the external evidence

Checked against a real Navidrome **v0.63.2** binary with `navidrome inspect`, on a library
tagged by babeltag itself, for all four formats:

```
                    with the generated snippet          without it
flac   {"artistcountry":["JP"],"language":["jpn"]}   {"language":["jpn"]}
mp3    {"artistcountry":["JP"],"language":["jpn"]}   {"language":["jpn"]}
m4a    {"artistcountry":["JP"],"language":["jpn"]}   {"language":["jpn"]}
ogg    {"artistcountry":["JP"],"language":["jpn"]}   {"language":["jpn"]}
```

This is the one contract babeltag cannot enforce from inside its own test suite, because it
depends on another program. Re-run the check when Navidrome changes its tag mapping.

## Design decisions that are NOT bugs

- **No statistical language detection.** Song titles are 2–4 words, far below where such
  detection is reliable. A confidently wrong `deu` across a library is worse than a blank.
- **Script detection outranks MusicBrainz by default.** A kana title *is* Japanese; a work
  relation is often simply absent. `--language-source musicbrainz` inverts this for users who
  want maximum accuracy over speed.
- **Confidence is not written into files.** It lives in the plan and the report, so libraries
  stay clean.
- **Append-only JSONL, not SQLite.** Crash-safe for free, zero dependencies, no experimental
  API, no Node-version floor.
- **`releasecountry` is deliberately not written.** Picard already writes it and it answers
  the wrong question.
