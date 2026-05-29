# stbarnabas-social

Automated social-media **poster generator** for **St Barnabas Church, Ealing**. It reads the
parish's styled HTML music list, works out the Common Worship occasion and readings for each
date, sources liturgically appropriate sacred art, and renders one 1080×1350 poster per
service-day in a house style — full-bleed art with the **complete music list shown
prominently** over a dark scrim.

The tool produces files for you to post **manually**. It never posts anywhere itself.

## How it works

```
node index.js parse  [out/services.json]   # music-list.html → date objects (canonical shape)
node index.js images [out/services.json]   # per poster: manifest cache → ACT/Wikidata → Commons
node index.js review                        # interactive approval; downloads art + writes manifest
node index.js build  [out/services.json]    # compose + render every approved poster → out/
```

- `parse` and `build` are non-interactive and **re-runnable** — tweak the template and rebuild
  without re-approving art.
- `review` is the **only** interactive step. Approval (the manifest) is kept separate from
  rendering on purpose.
- A poster is produced **per date**. A day with two services (e.g. a Sung Mass + Choral
  Evensong) becomes **one combined poster** listing both. A **transferred-feast** date
  produces **two variants** — one headlined with the feast (e.g. *St Barnabas the Apostle*),
  one with the ordinary liturgical day (e.g. *The First Sunday after Trinity*) — so you can
  choose which to post.

## Setup

```
npm install
```

Node ≥ 18. `npm install` also downloads a bundled Chromium (for Puppeteer) and the `sharp`
image binaries.

Then place the required inputs (the build **stops and tells you** if any are missing — it
never guesses):

| Input | Path | Notes |
|------|------|-------|
| Logo | `assets/logo.png` | The supplied St Barnabas logo. A white knockout of the *graphic mark only* is derived to `assets/logo-white.png`. |
| Music list | `samples/music-list.html` | The real parish music list — the parser is tested against this exact file. |
| Reference posters | `samples/reference-posters/` | Optional house-style reference JPEGs. |

`config.json` holds the church name, location strap, patron, poster dimensions, fonts, and the
descriptive User-Agent sent to image sources.

### Regenerating the logo white knockout

`assets/logo-white.png` is derived from `assets/logo.png` with `sharp`: the graphic mark is
cropped from the lockup, then the artwork's luminance becomes the alpha channel (white →
transparent) and is filled white, with a near-white threshold to suppress JPEG edge ringing.
Re-run the derivation if the source logo changes.

### Refreshing the fonts

The poster uses **Cormorant Garamond** (display) and **Source Serif 4** (body), including real
italics. Local `.woff2` copies live in `assets/fonts/` (manifest: `assets/fonts/fonts.json`)
and are base64-embedded into the rendered page so Puppeteer never silently falls back to a
system serif — the renderer **fails loudly** if a required face is missing. To refresh, re-run
the font fetch (downloads the `latin` subset of each weight/style from Google Fonts).

## Liturgical calendar

Common Worship is authoritative. The calendar engine (`src/lib/lectionary/calendar.js`) and
the lectionary data (`src/data/lectionary-coe.json`) are **vendored from the `precentor`
app** (which scraped the official Church of England Common Worship lectionary); only the
reference/structure data is included, not any copyrighted Bible text.

- `src/cw-calendar.js` adds the **"Nth Sunday after Trinity"** naming the parish list uses,
  feast-**transfer** logic for Principal Feasts and Festivals (`src/data/feasts-cw.json`),
  and the readings used as the image search's scripture axis.
- **Parser wins:** when the music list states an occasion (including local transfers like
  *Patronal (transferred)* or *St Barnabas (observed early)*), that is what the poster shows;
  the computed calendar is only a fallback and enrichment source.

## Image sourcing and licence

Art is sourced through a tiered chain that always tries to find something appropriate:

1. **manifest cache** — a previously approved, feast-tagged image (offered first);
2. **ACT via Wikidata** — Art in the Christian Tradition records (Wikidata property **P9092**)
   that depict the occasion's subject, resolved to their Wikimedia Commons image;
3. **Wikimedia Commons** — keyword/scripture search backstop (only free-licensed images).

Candidates are quality-filtered (actual artworks, ≥1080 px on the short side) and shown as a
local HTML contact sheet so the art can be judged before approval. Each candidate carries an
**exact attribution**; credits are never fabricated.

> **Licence / scope.** Images are used for **St Barnabas liturgical announcements only**
> (non-commercial, religious/educational). Wikimedia Commons hosts only free licences;
> attribution is recorded and written into each poster's `.caption.txt` — **never burned into
> the image**. Do not adapt this tool for commercial use.

## Output

For each built poster, `out/` contains:

- `out/{serviceKey}.png` — exactly **2160×2700** (1080×1350 @ deviceScaleFactor 2);
- `out/{serviceKey}.caption.txt` — a ready-to-paste caption (occasion, date, each service's
  full music) followed by the artwork attribution line.

`build` skips any date still awaiting art and reports which were skipped — it never crashes or
silently drops a service.

## Layout

```
assets/            logo.png, logo-white.png, fonts/
cache/             images/ (downloaded art, git-ignored), manifest.json (tracked), queries/
samples/           music-list.html, reference-posters/
src/               parse-musiclist · cw-calendar · act-client · compose · render · review
  lib/lectionary/  calendar.js (vendored from precentor)
  data/            lectionary-coe.json, feasts-cw.json
templates/         poster.html
out/               finished {serviceKey}.png + .caption.txt (git-ignored)
config.json · index.js
```

`node_modules/`, `cache/images/`, and `out/` are git-ignored; `cache/manifest.json` is tracked
(it is the useful long-term record of vetted, attributed art).

## Automated mode (always-on Mac mini)

The pipeline can run unattended: drop the music-list HTML into a Google Drive folder and the
finished posters appear in another. No review step runs; art is auto-selected and a generic
sacred artwork is used as a last resort, so every service always gets a poster.

### How it works

`scripts/watch.js` (run under `launchd`) watches a **Google Drive for Desktop**-mirrored
*input* folder. When a music-list `.html` settles there, it runs `node index.js auto`
(`parse → images → build`, no `review`) and copies the produced `*.png`, `*.caption.txt`, and
a `_run-summary.txt` into a per-list subfolder of the mirrored *output* folder. Drive for
Desktop syncs both folders — the app only ever reads and writes local files.

### One-time setup on the mini

1. Install **Google Drive for Desktop**, sign in, and set both folders to **mirror** locally.
2. `npm install` in this repo (Node ≥ 18).
3. Edit `config.json` → `automation.inputDir` / `automation.outputDir` to the two mirrored
   folder paths (under `~/Library/CloudStorage/GoogleDrive-…`). `settleSeconds` (default 10)
   is how long a file's size must hold steady before processing, so half-synced downloads are
   never parsed.
4. Edit `deploy/com.stbarnabas.social.watch.plist`, replacing every `/REPLACE/WITH/…` path
   (find your Node with `which node`), then install it:
   ```bash
   cp deploy/com.stbarnabas.social.watch.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.stbarnabas.social.watch.plist
   ```
   To stop it: `launchctl unload ~/Library/LaunchAgents/com.stbarnabas.social.watch.plist`.

### Operating notes

- **Each upload = one run.** Re-uploading the *same* file does nothing (content-hash dedup);
  upload a changed list to regenerate.
- **Output is grouped per list** under a folder named for the list's period, e.g.
  `2026-05_May-June/`.
- **`_run-summary.txt`** in each output subfolder is the "did it work?" record: posters made,
  the art used per poster, any generic-art fallbacks, and any render failures.
- **Failures** (e.g. an unparseable list) write a FAILED `_run-summary.txt` and are *not*
  marked processed, so a corrected re-upload retries automatically.
- **Logs** live in `cache/watch.log` (and `cache/launchd.{out,err}.log`) on the mini.
- The interactive `node index.js review` workflow is unchanged and still available when you
  want to hand-pick art.
