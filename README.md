# stremio-bilingual-subs

A Stremio subtitle add-on (built on `stremio-addon-sdk`) that serves
**Chinese + English two-line subtitles**.

For a movie it finds an existing bilingual file, or merges the best Chinese
and English ones into a single UTF-8 SRT: Chinese on line 1, English on line 2.
It runs as a Stremio add-on (milestone 2), and there's a CLI for testing
single movies (milestone 1).

## Setup

Requires Node 18+ (uses built-in `fetch`). Everything else lives inside this
folder. Nothing is installed system-wide.

```bash
npm install
cp .env.example .env    # then fill in keys
```

| Variable | Needed for |
|---|---|
| `OPENSUBTITLES_API_KEY` | OpenSubtitles REST API (search + download) |
| `OPENSUBTITLES_USERNAME` / `_PASSWORD` | optional, raises the daily download quota |
| `SUBDL_API_KEY` | SubDL |
| `ASSRT_TOKEN` | assrt.net |
| `MAX_DOWNLOADS_PER_PROVIDER` | SubDL/assrt downloads per language bucket (default 4) |
| `MAX_OPENSUBTITLES_DOWNLOADS` | OpenSubtitles downloads per language bucket (default 1) |
| `ALASS_PATH` | override the bundled alass |
| `CACHE_DIR` | download cache folder (default `cache/`; set empty to disable) |

Any provider without a key is skipped and logged as skipped.

### OpenSubtitles quota

Every OpenSubtitles download counts against a daily limit: 5 without
logging in, or 100 if the API consumer has **Under dev** ticked.

One run downloads at most 6 files from OpenSubtitles: 2 English and 4
Chinese. Chinese subs whose name suggests bilingual (`简体&英文`, `chs-eng`,
`中英`…) go first. Downloads run one at a time, because OpenSubtitles rejects
bursts. They are cached in `cache/`, so re-running a movie costs nothing.

### alass

[alass](https://github.com/kaegi/alass) v2.0.0 is used if found at
`tools/alass/alass-cli.exe` (download `alass-windows64.zip` from its releases
and keep only `bin/alass-cli.exe`), on PATH, or at `ALASS_PATH`. If it is
missing, a built-in aligner is used instead. That aligner finds a single offset or
framerate ratio, but it cannot fix drift.

## Running the Stremio add-on

```bash
npm start
```

The server prints its install addresses. Paste one into Stremio or Nuvio
(Add-ons → paste URL):

* **Stremio on this PC:** `http://127.0.0.1:7000/manifest.json`
* **Another device on your home network** (phone, TV): `http://<this PC's IP>:7000/manifest.json`.
  The official Stremio apps only accept plain `http://` for `127.0.0.1`, so
  other devices may need an HTTPS address. Windows asks once whether Node.js
  may accept network connections; allow it on **private** networks.

How it behaves:

* On a subtitle request, the add-on starts the search and waits up to 20 s
  (`ANSWER_WAIT_MS`). A slower search still returns the subtitle entry, and
  opening it waits for the search to finish.
* Results are saved in `results/` per movie and release filename, so the
  second time is instant. "No Chinese subtitles" is remembered for 6 hours.
* The subtitle is listed as Chinese (`chi`). Set `SUBTITLE_LANG=中英双语` to
  list it under its own name.
* A site that can't be reached (like assrt right now) is given 6 s, then
  skipped for 15 minutes.

Settings in `.env`: `PORT` (7000), `HOST` (`0.0.0.0`, or `127.0.0.1` for
this PC only), `SUBTITLE_LANG`, `ANSWER_WAIT_MS`.

Movies only for now; series come next.

## Running on a server (Docker)

GitHub Actions (`.github/workflows/docker.yml`) builds
`ghcr.io/<owner>/bilingual-subs:latest` for ARM64 and x86-64 on every push
to `main`.

* **alass:** the x86-64 image downloads the official binary. The ARM64 image
  compiles it from crates.io, using the crate's own 2019 lockfile. If that
  compile ever fails, the image still builds and uses the built-in aligner.
  The startup log's `aligner:` line shows which one is in use.
* **Secrets** go in the server's environment, never in the image (see
  `.dockerignore`).
* **Data:** a `/data` volume holds `cache/`, `results/` and `logs/`.

Server-only settings:

| Variable | Purpose |
|---|---|
| `PUBLIC_URL` | the https address your reverse proxy serves, e.g. `https://subs.example.com` |
| `ADDON_TOKEN` | secret path segment. The add-on only answers under `/<token>/`, so the install URL is `PUBLIC_URL/<token>/manifest.json`. Anyone with that URL can use your API quotas, so keep it private |
| `TZ` | time zone for log timestamps, e.g. `Asia/Singapore` |

`GET /health` returns `ok` without the token. The container health check uses it.

### Dockhand + Pangolin

This setup follows the RedHair self-hosting guide, where apps join the
`pangolin_frontend` network.

1. **Dockhand → Stacks → Create.** Name the stack `bilingual-subs` and paste
   `docker-compose.yml` on the left, with `CHANGE-ME` replaced by your GitHub
   username in lowercase.
2. **Environment panel (right):** add the contents of `.env.example` with your
   keys filled in. Also add:
   * `SUBTITLE_LANG=Chinese-English`
   * `PUBLIC_URL=https://subs.<your domain>`
   * `ADDON_TOKEN=`, set to a long random string, e.g. from `openssl rand -hex 24`
   * `TZ=Asia/Singapore`, or your own time zone
3. **Deploy.** The logs should show `aligner: /opt/alass/alass-cli`.
4. **Pangolin → Resources → Public → Add Resource:** subdomain `subs`, with
   target `bilingual-subs`, port `7000`, protocol `http`.
5. **Rules on that resource:** add a rule that bypasses auth for the path
   `/<ADDON_TOKEN>/*`. Everything else keeps Pangolin's login.
6. **Install in Nuvio/Stremio:**
   `https://subs.<your domain>/<ADDON_TOKEN>/manifest.json`
7. **Updates:** push to GitHub and wait for the Actions build. Then, in
   Dockhand → Stacks, use the stack's **Redeploy** button with **Pull images**
   ticked. Dockhand's "Check for updates" didn't notice a new `latest`. The log's
   first line shows the running version.

## CLI usage

```bash
node bin/fetch-subs.js tt0111161
node bin/fetch-subs.js tt0111161 "The.Shawshank.Redemption.1994.1080p.BluRay.x264-SPARKS.mkv"
node bin/fetch-subs.js tt0111161 -o shawshank.srt --dump dump/
```

* `-o, --out` sets the output file (default `out/<imdbId>.zh-en.srt`)
* `--dump <dir>` also saves every analysed candidate, decoded to UTF-8 SRT, for inspection

## How it works

1. **Search** OpenSubtitles (`en`, `zh-cn`, `zh-tw`, `ze`), SubDL (`EN`, `ZH`, `ZH_BG`)
   and assrt in parallel. assrt can't search by IMDb ID, so it searches by the
   title from Stremio's Cinemeta. Hits whose name has a different year are
   dropped.
2. **AI / machine-translation policy.** First the film's original language is
   decided from the first country Cinemeta lists. China, Hong Kong, Taiwan or
   Macau means Chinese; anything else means English/other.
   * The original-language side must be human-made. Any AI or machine-
     translated (AI/MT) sub on that side is discarded:
     - Chinese film: AI Chinese is discarded; AI English is allowed.
     - Any other film: AI English is discarded; AI Chinese is allowed.
   * The allowed AI/MT side is used only as a last resort. These subs are
     downloaded only when no human-made sub for that side turns up, and they
     score below every human-made file.

   A sub counts as AI/MT if OpenSubtitles flags it (`ai_translated` /
   `machine_translated`), or if its name, comment or credit lines say so
   (`机翻`, `AI翻译`, `machine translated`, …).
3. **Download.** For each provider and language bucket, the best release
   matches are downloaded first, then the most popular.
4. **Decode.** zip, rar and 7z archives are unpacked; 7z goes through 7-Zip
   compiled to WASM. The encoding is detected from BOM → UTF-16 heuristic →
   strict UTF-8 → GBK vs Big5. For GBK vs Big5, the bytes are decoded both
   ways and the one that yields more common Chinese characters wins. SRT,
   VTT and ASS/SSA are parsed. ASS lines that share the same timing (a common
   bilingual layout) are folded into one cue.
5. **Detect from content.** The provider's language label is ignored here:
   * language: the share of cues with CJK characters vs English words. If
     ≥40% of cues have both, the file is **bilingual**.
   * Simplified vs Traditional: the Chinese text is run through OpenCC
     `t→s`. If more than 5% of characters change, it is Traditional.
   * duplicates across providers are dropped.
6. **Timing check** against an English reference. The reference is the
   human English file with the best release match. Each Chinese or bilingual
   file is aligned to it with alass, and the result is classified:

   | verdict | meaning | what happens |
   |---|---|---|
   | `in-sync` | already matches | nothing |
   | `offset` | one constant delay and/or a 23.976↔25 fps ratio | corrected automatically |
   | `drift` (corrected) | different parts were off by different amounts, and the re-timed result lines up section by section | corrected, scores lower |
   | `drift` (not correctable) | still out of sync after alignment | bilingual bonus removed |

   For the check, the aligned file is cut into 6 chunks. Each chunk is
   re-matched on its own, and its best shift should be about 0 s.
7. **Score.** The weights make each criterion outrank the ones after it:

   | criterion | points |
   |---|---|
   | already bilingual (unless drift can't be corrected) | 1000 |
   | release match (group, source, resolution, edition) | 0–400 |
   | timing: in-sync 200, offset 100–200 (smaller is better), corrected drift 50 | 0–200 |
   | cue-count completeness vs English reference | 0–100 |
   | Simplified | 50 |
   | AI/MT translated | −3000 |

   The log prints each candidate's breakdown.
8. **Output.**
   * If the top candidate is bilingual, its lines are normalised to Chinese
     first, then English. It is re-timed to the English reference only if
     that reference matches your release at least as well. Otherwise the
     bilingual file might be the one in sync with your video.
   * Otherwise the best Chinese file (already aligned) is merged into the
     English timeline as `中文\nEnglish`.
   * If no English subtitle exists, the Chinese file is written alone.

The alignment only knows "right" relative to the English subtitle. It can't
hear your video. That's why the English reference is picked by release match.

## Tests

```bash
npm test    # offline checks + full pipeline against stubbed provider APIs
```

## Layout

```
Dockerfile               server image (x86-64 / ARM64)
docker-compose.yml       container setup for a VPS
bin/server.js            Stremio add-on server (npm start)
bin/fetch-subs.js        CLI
src/addon.js             manifest + subtitles handler
src/jobs.js              background searches, saved results
src/pipeline.js          orchestration, AI policy, logging
src/providers/*.js       opensubtitles, subdl, assrt
src/archive.js           zip / rar / 7z extraction
src/cache.js             download cache
src/encoding.js          charset detection → UTF-8
src/subtitle.js          SRT/VTT/ASS parse, SRT write
src/detect.js            language, bilingual, Simplified/Traditional, AI/MT markers
src/release.js           release-name matching
src/align.js             alass wrapper, fallback aligner, timing verdicts
src/score.js             scoring weights
src/merge.js             two-line merge
tools/alass/             local alass-cli.exe (not in git; see "alass")
.github/workflows/        image build for GHCR
```

## Known limits (milestone 1)

* Movies only; series/episodes come later.
* The original language is guessed from country, so a Hong Kong film shot in
  English would be treated as Chinese.
* assrt's API server (`api.assrt.net`) timed out during testing on
  2026-10-26, even though its website loaded. Its code follows the public docs
  but hasn't run against the live API yet.
* SubDL's language labels are unreliable. A file labeled Big5 Chinese turned
  out to be Arabic. Such files are caught because real Chinese is ~50% common
  characters, and garbled text is ~1%.
* No built-in translation. AI subs are only used when a site already offers them.
