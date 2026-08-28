# Babeltag

Tag your music library by **artist country** and **song language**, so Navidrome smart
playlists can split it into shows.

```
babeltag scan  /music
babeltag apply /music --yes
babeltag playlists /music
```

You end up with `Japanese`, `Hebrew`, `German`, `Instrumental`, `Japan`, `Israel` … playlists
that stay correct as your library grows, because they are smart playlists over real tags —
not frozen track lists.

---

## Why this exists

Mood taggers listen to the audio. Audio does not tell you what language someone is singing
in, or where the band is from. So a mixed library — English, German, Hebrew, Japanese, plus a
pile of video-game instrumentals — ends up in one undifferentiated heap.

The obvious fix is MusicBrainz, and the obvious tag is `releasecountry`. **That tag answers
the wrong question.** It is where the *album* was released:

- a J-Rock album released in the US reads as American
- an English-language album by a US band released in Japan reads as Japanese

Babeltag asks the two questions you actually meant:

| Question | Where the answer comes from |
|---|---|
| Where is this **artist** from? | The MusicBrainz *artist*, not the release |
| What language is this **sung** in? | The writing system, and the MusicBrainz *work* |

## What it writes

| Tag | Value | Navidrome setup |
|---|---|---|
| `ARTISTCOUNTRY` | ISO 3166-1 alpha-2 — `JP`, `DE`, `IL` | One generated config line |
| `LANGUAGE` | ISO 639-3 — `jpn`, `deu`, `heb`, `zxx` | **None.** Navidrome already reads it |

`zxx` is ISO 639-3 for "no linguistic content" — the code MusicBrainz itself uses for an
instrumental, so your video-game music sorts itself out.

Written using the exact per-format keys Navidrome matches on:

| Format | Country | Language |
|---|---|---|
| FLAC / OGG / Opus | Xiph `ARTISTCOUNTRY` | Xiph `LANGUAGE` |
| MP3 | `TXXX:ARTISTCOUNTRY` | `TLAN` frame |
| M4A / MP4 | `----:com.apple.iTunes:ARTISTCOUNTRY` | `----:com.apple.iTunes:language` |

## Install

```bash
npm install -g babeltag     # needs Node 20+
```

Or Docker:

```bash
docker run --rm -v /path/to/music:/music ghcr.io/babeltag/babeltag scan /music
```

## Use it

### 1. Scan — this never touches your files

```bash
babeltag scan /music
```

```
Found 4213 taggable files.
  4213/4213 resolved (3980 from cache)
Plan written to /music/.babeltag/plan.json

4213 track(s) in the plan.

By country:
  JP  Japan                    1840
  US  United States             902
  IL  Israel                    311
  --  no country found          244

By language:
  jpn Japanese                 1795
  eng English                  1102
  zxx Instrumental              688
  heb Hebrew                    301
  --- no language found         327

3886 tag value(s) would be written across 2402 file(s).
```

### 2. Apply — the only command that writes

```bash
babeltag apply /music --yes
```

Every change is journalled first. If anything looks wrong:

```bash
babeltag undo /music
```

### 3. Playlists + Navidrome config

```bash
babeltag playlists /music
```

Writes one `.nsp` per country and language, plus the config snippet. Add it to your
`navidrome.toml`:

```toml
Tags.artistcountry.Aliases = ["artistcountry", "txxx:artistcountry", "----:com.apple.itunes:artistcountry"]
```

Then **run a full scan** in Navidrome. A quick scan will not pick up tag-configuration
changes, and your new tag will silently stay invisible. This is the single most common way to
end up with nothing.

### 4. Point sub/wave at the playlists

Each generated smart playlist becomes a show source. `language-Japanese.nsp` is your J-pop
show; `language-Instrumental.nsp` is your video-game music show. Mood tags still work on top —
they set the vibe, the playlist sets the pool.

---

## How it decides

Nothing is ever guessed silently. Every value carries a confidence, and only `high` and
`medium` are written (`--min-confidence high` for the strict version).

### Artist country

1. **MusicBrainz ID already in the file** → direct artist lookup. *high*
2. **No ID** → name search, accepted only at score ≥ 95, clearly ahead of the runner-up, and
   only for a real act. *medium*
3. Otherwise → left alone, and reported.

> The search deliberately uses a plain query, not `artist:Name`. The fielded form searches
> only the primary name: `artist:Yorushika` returns **zero** results, because MusicBrainz
> stores that artist as ヨルシカ with `Yorushika` as an alias. The plain query returns it at
> score 100. Every non-Latin artist in your library depends on this.

### Song language

1. **A writing system that means one language** → done, no network call.
   Kana → `jpn`, Hangul → `kor`, Hebrew → `heb`, Greek → `ell`, Thai → `tha`. *high*
2. **A shared writing system** → narrowed using the artist's country. Arabic script is also
   Persian and Urdu; Cyrillic is also Ukrainian and Bulgarian; bare kanji could be Chinese.
   Without a country these stay unresolved rather than defaulting to the popular guess. *medium*
3. **Latin script** → the MusicBrainz *work* language, which is what the song is sung in.
   An instrumental becomes `zxx`. *high*
4. **Nothing conclusive** → `unknown`, honestly.

There is deliberately **no statistical language detection**. A three-word song title is far
below the length where that is reliable, and a confidently wrong `deu` across your whole
library is worse than a blank.

Because step 1 is free, a Japanese or Hebrew library costs almost no network at all. Use
`--language-source musicbrainz` to ask MusicBrainz first instead — more accurate for a
Latin-script library, and it catches oddities like a Japanese title sung in English, at the
cost of one request per second per track.

## Safety

This edits files you cannot re-download, so:

- **`scan` cannot write.** It opens files read-only; a test asserts the bytes are unchanged.
- **`apply` is separate and explicit**, and does nothing without `--yes`.
- **Journal first, then write.** A run killed at any moment leaves a complete record.
- **`undo` restores exactly** — including removing a tag that did not exist before.
- **Existing values are never overwritten** without `--overwrite`.
- **Every write is read back** and verified; a mismatch aborts the run.
- **A test proves the decoded audio stream is byte-identical** before and after tagging.
- A lock file stops two runs colliding, and re-running `apply` is a no-op.

## Being a good citizen

MusicBrainz is free and run by a non-profit. Babeltag sends a real User-Agent, never exceeds
one request per second, honours `Retry-After`, and caches every answer — so a re-scan after
adding a few albums costs a few requests, not thousands. If the service is busy, affected
tracks are reported as "try again later" and nothing bad is cached.

## Commands

```
babeltag scan <library>       Look at the library and write a plan. Never edits files.
babeltag apply <library>      Write the planned tags. Journals every change.
babeltag undo <library>       Put every tagged file back exactly as it was.
babeltag playlists <library>  Generate Navidrome smart playlists + config snippet.
babeltag config               Print the navidrome.toml snippet and exit.
```

| Flag | Does |
|---|---|
| `--offline` | Skip MusicBrainz; script detection still works |
| `--language-source script\|musicbrainz` | Which source to try first (default `script`) |
| `--refresh-cache` | Throw away cached lookups |
| `--yes` | Actually write (apply) |
| `--min-confidence high\|medium` | How sure to be before writing (default `medium`) |
| `--overwrite` | Replace values that are already set |
| `--out <dir>` | Where playlists go |
| `--min-tracks <n>` | Skip a country/language with fewer than n tracks |

Everything babeltag creates lives in `<library>/.babeltag/` — plan, cache, journal, lock.
Delete that folder and it is as if it never ran.

## Verified, not assumed

The tricky claims here were checked against the real thing rather than the docs:

- Custom tags round-trip on **FLAC, MP3, M4A and OGG** — tested on real audio files.
- **Navidrome v0.63.2 actually reads both tags** on all four formats, using the config
  snippet babeltag generates. Confirmed with `navidrome inspect`: with the snippet,
  `{"artistcountry":["JP"],"language":["jpn"]}`; without it, `{"language":["jpn"]}` — which
  is exactly why country needs one config line and language needs none.
- Tagging leaves the decoded audio stream byte-identical.
- `artist:Yorushika` really does return zero results while plain `Yorushika` returns ヨルシカ.

## Development

```bash
npm install
npm test          # 113 tests, no network, no ffmpeg required
npm run typecheck
npm run build
```

## What it does not do

- **Import festivals from an iCal feed.** That is a sub/wave feature, not a metadata concern.
- **Guess a language from a Latin-script title.** See above.
- **Write `releasecountry`.** Picard already does, and it answers the wrong question.

## Licence

MIT
