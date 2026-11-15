# Notes

## Review backlog (findings 16 to 36)

From the full code review done with Fable on 2026-11-15. Findings 1 to 15 (groups A and B) were applied in v0.7.0.

How to use: work one group at a time ("Apply group C from NOTES.md, with tests, then show me the diff before pushing"). Line numbers are from commit `7daa4a5`, before the v0.7.0 changes, so some have moved; find the code by the function or file named. "Verified" means a check was run; "inferred" means from reading the code only.

Needs a decision before implementing: 26 (replace the SDK), 34 and 35 (new sources), 36 (AI translation). Plan those with Opus or Fable.

### C. Smaller edge cases

Status: 16, 18 and 19 are done (committed in 69c26d1 and deployed). 17 is held for Opus or Fable because it adds a threshold to language detection.

**16. Anime ID mapping gaps** (src/anime.js:27, src/anime.js:93; verified counts)
The `movie` flag is computed but never used. 1,178 of 8,004 mapped Kitsu entries have no season and default to season 1. Unknown how Nuvio sends anime movies.
Fix: treat MOVIE entries as movies; log when the season is a guess. Risk: low.

**17. Japanese can pass as Chinese** (src/detect.js:65-69; verified on a small sample)
Fix: classify as "other" when kana is over about 5% of the text. Risk: very low.

**18. Chinese file names inside zips can be garbled** (src/archive.js:16-19; partly verified)
GBK name bytes read as UTF-8 are garbage, so `第06集` would not match. Not confirmed what adm-zip does by default.
Fix: decode the raw name as GBK when it is not valid UTF-8. Risk: low.

**19. Cues shifted before 0:00 become zero-length** (src/subtitle.js:99-100; verified)
Fix: drop cues that end at or before 0. Risk: none.

### D. Merge quality

Status: 20 to 25 are untouched and held for Opus or Fable (20 changes every merged title and needs a before and after comparison on real titles; 25 changes a matching rule).

**20. A Chinese line spanning two English cues only attaches to one** (src/merge.js:13-30; verified)
The second English cue shows no Chinese. In the first real Shawshank merge, 177 of 1,822 cues were English-only.
Fix: join the English cues the Chinese line covers (capped by length). Risk: medium; changes every merged title, so compare before and after on a few real titles.

**21. Unmatched Chinese cues overlap English cues in time** (src/merge.js:25-36; verified)
Players stack them in unpredictable order.
Fix: attach on any real overlap, otherwise trim. Risk: low.

**22. English reference can be a hearing-impaired file** (src/pipeline.js:181, src/providers/opensubtitles.js:77-89; inferred from output)
"[Woman's Voice]" appeared in the House result. `foreign_parts_only` and multi-CD entries are not excluded either.
Fix: carry those flags, prefer plain files, strip sound tags. Risk: low.

**23. Chinese files containing some English lines duplicate the English** (src/merge.js:26; inferred, not reproduced)
Fix: use only the Chinese lines of a Chinese cue. Risk: low.

**24. Traditional-only results could be converted to Simplified** (optional)
OpenCC is already installed. Risk: low; phrase conversion is not perfect.

**25. Second-timing votes split on rounding** (src/pipeline.js:371; inferred)
1.0 s and 1.1 s count as different timings.
Fix: group within 200 ms. Risk: none.

### E. Security and robustness

Status: 27 is done (size limits; the assrt http links are still plain http). 28 is done (SHA-256 check of the amd64 alass download in the Dockerfile; the ARM build compiles from crates.io and is not covered). 26 needs a decision. 29 untouched.

**26. `npm audit`: 4 high, 2 low, all through `stremio-addon-sdk`** (verified)
ReDoS in its router's `path-to-regexp`; the rest are in its CLI parts. Only token holders can reach it. npm's suggested fix is a major downgrade.
Fix: replace the SDK with about 40 lines of our own routes. Risk: medium. Needs a decision.

**27. No size limits on downloads or archives; assrt links are plain http** (src/http.js:41-44, src/archive.js:19; inferred)
Fix: 30 MB download cap, 5 MB per extracted file. Risk: none.

**28. alass is downloaded in the Docker build without a checksum** (Dockerfile:12; inferred)
Fix: verify a SHA-256. Risk: none.

**29. Minor** (inferred)
`X-Forwarded-Host` is trusted when `PUBLIC_URL` is unset (it is set on the VPS). The OpenSubtitles login token is never refreshed (login is not used).

### F. Maintainability

Status: 30 is done (version read from package.json). 31 is open; the release.js "WEB-DL" part changes a matching rule, so it needs Opus or Fable.

**30. Version lives in three places** (src/addon.js:15, src/config.js:14; verified)
The User-Agent still says v0.3.0. Fix: read it from `package.json`.

**31. No tests for jobs, add-on, server or anime code**
Every Nuvio-facing bug this month was there (v0.7.0 added some jobs tests). Also src/release.js:29 reads "WEB-DL" as release group "dl" (verified, 0.80 false match); it only matters for players that send a file name, which Nuvio does not.

### G. Better language fetching

**32. OpenSubtitles: add Cantonese (`zh-ca`) and a second page when Chinese results are few.** Gain unknown.

**33. Running-total episode numbers only apply to OpenSubtitles**, not SubDL, assrt or pack file names (src/providers/opensubtitles.js:32-41). v0.7.0 added running totals for pack file names (`pickEpisodeFiles`); SubDL and assrt are still open.

**34. Search assrt by Chinese title too.** Wikidata gives it by IMDb ID with no key. Unsure of the gain: assrt had nothing for the three Chinese titles tried. Needs a decision.

**35. New sources with real APIs:** SubSource (free key), Wyzie (key already held), AnimeTosho (official subtitle tracks from anime releases; API details unverified). Needs a decision.

**36. Chinese-original titles need a decision.** (Since then, English-original titles with no Chinese anywhere get DeepL / Claude Haiku translation; see README. Chinese-original titles are still open.) No Chinese file exists on any source with an API (verified for two shows). Options: an English-only entry, or AI translation with your own key, cached per title and marked as AI. The second is what MultiSub does and would allow cancelling it, but it reverses the rule that Chinese must be human-made for Chinese titles.

Checked and fine during the review: startup import takes 67 ms, a corrupt 7z does not kill the process, and Nuvio history only uses `tt`, `mal` and `kitsu` IDs, all of which the add-on accepts.
