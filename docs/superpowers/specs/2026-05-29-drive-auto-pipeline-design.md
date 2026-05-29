# Design: Google Drive auto-pipeline

**Date:** 2026-05-29
**Project:** stbarnabas-social (liturgical poster generator)
**Status:** Approved (design); awaiting plan

## Goal

Run the poster pipeline automatically, with no human in the loop:

1. When a new music-list HTML is uploaded to a designated **input** Google Drive folder, the
   app runs end-to-end and produces posters.
2. Every produced poster (and its caption) is uploaded to a designated **output** Google
   Drive folder.

The host is an always-on **Mac mini** running **Google Drive for Desktop**, which mirrors both
folders to the local filesystem. The app reads and writes local files; Drive for Desktop owns
all sync. No Google API, OAuth, or stored credentials are involved.

## Decisions taken during brainstorming

- **No review step.** The interactive `review` command is *not* run in the automated flow. It
  stays in the codebase, untouched, for occasional hand-curation.
- **Art is auto-selected.** `build` already falls back to the top auto-sourced candidate when
  no manifest entry exists, so unattended selection is mostly "don't run `review`."
- **Never blank.** If the existing tiered chain finds no art for a service, the app sources a
  *generic religious artwork* rather than skipping the date or rendering a plain background.
- **Input is HTML.** The same styled music-list HTML the current parser is tested against. No
  PDF parsing (PDF would discard the structure the parser depends on; the HTML is the source
  of truth).
- **Sync via the local mirror, both directions.** Not the Drive API — the Mac mini + Drive for
  Desktop already solve sync reliably, with zero auth surface.
- **Outputs grouped per list** in an output subfolder named from the list's period.
- **No email/SMS.** A `_run-summary.txt` synced into the output folder is the "did it work?"
  signal.

## Architecture

```
[Drive input folder]  --mirror-->  [local input dir]
        │ new .html lands
        ▼
   launchd watcher (Mac mini)
        │ debounce → dedup → lock
        │ copy HTML → samples/music-list.html
        ▼
   node index.js auto   (parse → images → build, NO review)
        │ out/*.png  out/*.caption.txt  _run-summary.txt
        ▼
   copy into [local output dir]/<period>/
        │
        ▼
[Drive output folder]  --mirror-->  uploaded by Drive for Desktop
```

### Components

**1. `node index.js auto` — non-interactive orchestrator**

A new command that runs `parse`, then `images`, then `build` in sequence in one process,
skipping `review`. Reuses the existing `cmdParse` / `cmdImages` / `cmdBuild` functions. On any
step throwing, it exits non-zero with the error (the watcher records it).

- **Depends on:** existing step functions in `index.js`, intermediate files
  (`out/services.json`, `out/candidates.json`).
- **Interface:** `node index.js auto` → exit 0 on success (even if some dates fell back to
  generic art), non-zero on hard failure (e.g. unparseable list).
- **Unchanged:** `parse`, `images`, `review`, `build` keep their current behaviour and
  signatures.

**2. Generic sacred-art backstop (in `src/act-client.js`)**

A final tier in `sourceCandidates`, used only when manifest → ACT/Wikidata → Commons all yield
nothing. It returns one or more free-licensed, public-domain generic religious artworks drawn
from a curated pool (a Wikimedia Commons category of public-domain sacred paintings, or a
small vendored allow-list of Commons file titles).

- Quality-filtered identically to other candidates (real artwork, ≥1080px short side).
- Carries a correct Commons attribution (never fabricated), exactly like other candidates.
- Returns a **pool**, not a single fixed image, and the existing `usedGlobal` de-dup in
  `build` ensures different dates don't all receive the *same* fallback artwork.
- After this tier, `candidates` is never empty, so `images` no longer emits `NEEDS MANUAL` for
  the automated path and `build` never adds a date to `skipped`.
- **Interface:** same candidate shape already consumed by `build`/`review`
  (`{ thumbUrl, fullUrl, title, source, licence, width, height, attribution, ... }`).

**3. Watcher (`scripts/watch.js`) + launchd job**

A standalone Node script (no new heavy deps; uses `fs.watch`/stat polling) that monitors the
local input dir.

- **Debounce / sync-complete detection:** wait until the file's size is stable for N seconds
  before processing (Drive for Desktop streams downloads; a half-synced file must not be
  parsed). N configurable; default ~10s.
- **Dedup:** keep a small state file (e.g. `cache/processed.json`) mapping input-file
  content-hash → timestamp; skip a list whose hash was already processed. Re-uploading a
  changed list (new hash) reprocesses.
- **Locking:** a lockfile prevents a second upload from starting a concurrent `auto` run;
  the later event queues or is skipped-and-logged.
- **Run:** copy the settled HTML to `samples/music-list.html`, spawn `node index.js auto`,
  capture stdout/stderr.
- **Publish:** copy `out/*.png` and `out/*.caption.txt` into
  `<output dir>/<period>/`, where `<period>` is derived from the list (its `.doc-period` /
  `<title>`, slugified, e.g. `2026-05_May-June`). Also write `_run-summary.txt` there.
- **Local log:** append a rolling log on the mini (`cache/watch.log`) with each run's outcome.
- **launchd:** a `LaunchAgent` plist (documented, not auto-installed) keeps the watcher alive
  and restarts it on crash / login.

**4. `_run-summary.txt`**

Written into the per-list output subfolder each run:

- count of posters built and the targets covered;
- the artwork (title + source/attribution) used per poster;
- which dates fell back to **generic** art;
- any render failures (`build` already collects `failed`);
- the run timestamp and the source list's filename + period.

**5. Config (`config.json` → `automation` block)**

```jsonc
"automation": {
  "inputDir":  "/Users/<user>/Library/CloudStorage/GoogleDrive-.../<input folder>",
  "outputDir": "/Users/<user>/Library/CloudStorage/GoogleDrive-.../<output folder>",
  "settleSeconds": 10
}
```

No paths hardcoded. Absent/invalid config fails loudly with a clear message.

## Data flow

1. Drive for Desktop writes the uploaded HTML into `inputDir`.
2. Watcher detects it, waits for size to settle, checks the hash isn't already processed.
3. Watcher copies it to `samples/music-list.html`, takes the lock, runs `node index.js auto`.
4. `auto`: `parse` → `out/services.json`; `images` → `out/candidates.json` (generic backstop
   guarantees ≥1 candidate per target); `build` → `out/<dd-mm-yyyy>...-{a,b}.png` + captions.
5. Watcher copies posters + captions + `_run-summary.txt` into `outputDir/<period>/`.
6. Drive for Desktop uploads them to the output Drive folder.
7. Watcher records the hash as processed and appends to `cache/watch.log`; releases the lock.

## Error handling

- **Half-synced input:** size-settle debounce before processing.
- **Unparseable list:** `auto` exits non-zero; watcher logs it to `cache/watch.log` and writes
  a failure note as `_run-summary.txt` in the output folder so the failure is visible in Drive;
  the input hash is **not** marked processed (so a corrected re-upload retries).
- **One bad image:** `build` already isolates per-poster failures (`failed[]`) and keeps going.
- **No art anywhere:** can't happen for the automated path once the generic backstop exists;
  if the backstop *itself* fails (e.g. network down), that poster lands in `failed[]` and is
  reported in the summary.
- **Concurrent uploads:** lockfile serialises runs.
- **Drive app not running / not synced:** out of the app's control; documented as a deployment
  prerequisite. (This was the explicit trade-off accepted in choosing the mirror over the API.)

## Testing

- **Parser/pipeline:** unchanged existing behaviour; `auto` is a thin sequence over tested
  steps — a smoke test that `auto` runs all three and produces ≥1 poster from the sample list.
- **Generic backstop:** unit test that `sourceCandidates` returns a non-empty, quality-filtered,
  attributed candidate when the upstream tiers are stubbed to return nothing; and that repeated
  calls vary (pool, not constant) so `usedGlobal` can de-dup across dates.
- **Watcher (pure logic, no Drive needed):** size-settle debounce, content-hash dedup, period
  slug derivation, and lock acquisition tested against a temp directory with simulated file
  writes. Drive sync itself is not unit-tested (it's the desktop app's responsibility).
- **End-to-end (manual, documented):** drop the sample HTML into a temp "input" dir, confirm
  posters + captions + summary appear in a `<period>/` "output" dir.

## Out of scope (YAGNI)

- Google Drive API, OAuth, service accounts.
- Auto-posting to social platforms (the tool deliberately only produces files).
- Email/SMS notification.
- PDF or Word input.
- Any change to poster composition, calendar logic, or image-quality rules beyond adding the
  backstop tier.

## Deployment prerequisites (Mac mini)

- Google Drive for Desktop installed, logged in, both folders set to mirror locally.
- Node ≥ 18 and `npm install` already run in the repo.
- The `launchd` LaunchAgent installed and loaded (documented in README).
- `config.json` `automation` paths point at the two mirrored folders.
