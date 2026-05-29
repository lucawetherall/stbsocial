# Google Drive Auto-Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the poster pipeline run unattended on an always-on Mac mini — triggered by a music-list HTML appearing in a Drive-mirrored input folder, producing posters that land in a Drive-mirrored output folder, with no human review step and never a blank poster.

**Architecture:** A `launchd`-managed watcher (`scripts/watch.js`) detects a settled HTML file in the input mirror, copies it to `samples/music-list.html`, and runs a new non-interactive `node index.js auto` command (`parse → images → build`, no `review`). A generic sacred-art backstop in `act-client.js` guarantees every service gets art. The watcher then publishes the produced PNGs + captions + a `_run-summary.txt` into a per-list subfolder of the output mirror, which Google Drive for Desktop syncs. Pure, testable logic (hashing, debounce, locking, period-slug, publish, summary formatting) lives in `src/automation.js`; the watcher script is a thin wiring layer.

**Tech Stack:** Node ≥ 18 (CommonJS), `cheerio` (already a dep), Node built-in `node:test` runner + `node:assert` (no new dependencies), `launchd` for process supervision, Google Drive for Desktop for sync.

---

## File Structure

- **Create** `tests/automation.test.js` — unit tests for pure automation helpers.
- **Create** `tests/act-client.test.js` — unit tests for the generic backstop + build summary.
- **Create** `tests/auto.test.js` — unit test for the `auto` orchestration order.
- **Create** `src/automation.js` — pure helpers: content hash, period slug, processed-state, lockfile, size-settle, publish-from-report, run-summary formatting.
- **Create** `src/data/generic-sacred-art.json` — curated generic sacred-art search queries.
- **Create** `scripts/watch.js` — the launchd entrypoint (thin wiring over `src/automation.js`).
- **Create** `deploy/com.stbarnabas.social.watch.plist` — LaunchAgent template.
- **Modify** `package.json` — add `test` and `auto`/`watch` scripts.
- **Modify** `src/act-client.js` — add `genericSacredArt` tier + wire it into `sourceCandidates`.
- **Modify** `index.js` — add `auto` command (`runAuto`) and write `out/build-report.json` in `cmdBuild`.
- **Modify** `config.json` — add an `automation` block.
- **Modify** `README.md` — document the automated deployment.

Each task is self-contained and ends in a commit.

---

## Task 1: Test harness

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the test script and an `auto`/`watch` convenience script**

In `package.json`, replace the `"scripts"` block with:

```json
  "scripts": {
    "parse": "node index.js parse",
    "images": "node index.js images",
    "review": "node index.js review",
    "build": "node index.js build",
    "auto": "node index.js auto",
    "watch": "node scripts/watch.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Verify the runner works with zero tests yet**

Run: `npm test`
Expected: exits 0 with output like `# tests 0` / `# pass 0` (Node's built-in runner finds no `*.test.js` files yet and succeeds).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "build: add node:test runner and auto/watch npm scripts"
```

---

## Task 2: Generic sacred-art query list

**Files:**
- Create: `src/data/generic-sacred-art.json`

- [ ] **Step 1: Create the curated query pool**

These are broad, unambiguously *sacred-art* subjects. They are passed through the existing
`commonsSearch` (which already enforces the art-only allow-list, the ≥1080px gate, and
attribution), so each query reliably returns free-licensed religious paintings/icons.

Create `src/data/generic-sacred-art.json`:

```json
{
  "queries": [
    "Christ Pantocrator icon",
    "Madonna and Child painting",
    "Adoration of the Lamb painting",
    "Holy Trinity painting",
    "Christ in Majesty painting",
    "Annunciation painting",
    "Resurrection of Christ painting",
    "Transfiguration of Jesus painting",
    "Christ blessing painting",
    "Sermon on the Mount painting",
    "Last Supper painting",
    "Good Shepherd painting"
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add src/data/generic-sacred-art.json
git commit -m "feat: add generic sacred-art query pool for never-blank backstop"
```

---

## Task 3: `genericSacredArt` backstop tier in act-client

**Files:**
- Modify: `src/act-client.js`
- Test: `tests/act-client.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/act-client.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { genericSacredArt } = require("../src/act-client.js");

// A fake commonsSearch: returns a deterministic candidate per query so we can test the
// backstop's pooling/dedup/rotation WITHOUT touching the network.
function fakeSearch(results) {
  return async (q) => results[q] || [];
}

test("genericSacredArt returns attributed candidates tagged source=generic", async () => {
  const search = fakeSearch({
    "Christ Pantocrator icon": [
      { source: "commons", title: "Pantocrator", fullUrl: "https://x/a.jpg",
        artworkKey: "a|pantocrator", attribution: "“Pantocrator”. Source: Wikimedia Commons.",
        width: 2000, height: 2000, mime: "image/jpeg" },
    ],
  });
  const out = await genericSacredArt({ serviceKey: "2026-06-07" }, { search });
  assert.ok(out.length >= 1, "should return at least one candidate");
  assert.strictEqual(out[0].source, "generic");
  assert.ok(out[0].attribution.length > 0, "must carry an attribution");
});

test("genericSacredArt dedupes by artworkKey across queries", async () => {
  const dup = { source: "commons", title: "Pantocrator", fullUrl: "https://x/a.jpg",
    artworkKey: "a|pantocrator", attribution: "x", width: 2000, height: 2000, mime: "image/jpeg" };
  const search = fakeSearch({ "Christ Pantocrator icon": [dup], "Madonna and Child painting": [dup] });
  const out = await genericSacredArt({ serviceKey: "k" }, { search });
  assert.strictEqual(out.length, 1, "same artwork must not appear twice");
});

test("genericSacredArt rotation varies the first query by serviceKey", async () => {
  // Record which query is asked first for two different serviceKeys.
  const firstAsked = {};
  const mk = (key) => {
    let seen = false;
    return async (q) => { if (!seen) { firstAsked[key] = q; seen = true; } return []; };
  };
  await genericSacredArt({ serviceKey: "2026-06-07" }, { search: mk("a") });
  await genericSacredArt({ serviceKey: "2026-12-25" }, { search: mk("b") });
  // Not a hard guarantee of difference for all inputs, but these two keys must differ.
  assert.notStrictEqual(firstAsked.a, firstAsked.b);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/act-client.test.js`
Expected: FAIL — `genericSacredArt is not a function` (not yet exported).

- [ ] **Step 3: Implement the backstop**

In `src/act-client.js`, add these helpers immediately **above** the `async function sourceCandidates(target)` definition:

```js
// ─── Tier 5: generic sacred-art backstop (never blank) ──────────
// Used ONLY when every upstream tier returned nothing, so a poster is ALWAYS produced.
// Reuses commonsSearch over a curated pool of generic sacred subjects (already art-only,
// size-gated, and attributed). The pool is rotated by a deterministic hash of the target so
// different dates tend to draw different fallbacks; build's usedGlobal de-dup then ensures
// no two posters in one run share the same artwork.
const GENERIC_QUERIES = require("./data/generic-sacred-art.json").queries;

function rotate(arr, offset) {
  if (!arr.length) return arr.slice();
  const n = ((offset % arr.length) + arr.length) % arr.length;
  return arr.slice(n).concat(arr.slice(0, n));
}

// FNV-1a — a tiny deterministic string hash (no Math.random; stable across runs).
function strHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(s).length; i++) {
    h ^= String(s).charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

async function genericSacredArt(target, { search = commonsSearch } = {}) {
  const queries = rotate(GENERIC_QUERIES, strHash(target.serviceKey || target.occasion || ""));
  const out = [];
  const seen = new Set();
  for (const q of queries) {
    if (out.length >= 6) break;
    const results = await search(q).catch(() => []);
    for (const cand of results) {
      const id = cand.artworkKey || cand.fullUrl;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ ...cand, source: "generic" });
      if (out.length >= 6) break;
    }
  }
  return out;
}
```

Then add `genericSacredArt` to the `module.exports` object at the bottom of the file:

```js
module.exports = {
  sourceCandidates,
  commonsSearch,
  wikidataActSearch,
  commonsFileInfo,
  readManifest,
  politeFetch,
  buildAttribution,
  genericSacredArt,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/act-client.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/act-client.js tests/act-client.test.js
git commit -m "feat: add genericSacredArt backstop tier (reuses commonsSearch)"
```

---

## Task 4: Wire the backstop into `sourceCandidates`

**Files:**
- Modify: `src/act-client.js`

- [ ] **Step 1: Add the backstop call before the return**

In `src/act-client.js`, find the end of `async function sourceCandidates(target)`. It currently ends:

```js
  for (const q of commonsQueries) {
    if (out.length >= 6) break;
    const c = await commonsSearch(q).catch(() => []);
    if (c.length) axisUsed = axisUsed || (subjectKeywords.includes(q) ? "subject" : "scripture/occasion");
    c.forEach(push);
  }

  return { candidates: out.slice(0, 6), axisUsed, needsManual: out.length === 0 };
}
```

Insert the backstop between the loop and the `return`:

```js
  for (const q of commonsQueries) {
    if (out.length >= 6) break;
    const c = await commonsSearch(q).catch(() => []);
    if (c.length) axisUsed = axisUsed || (subjectKeywords.includes(q) ? "subject" : "scripture/occasion");
    c.forEach(push);
  }

  // Tier 5 — generic sacred-art backstop: only if nothing else was found, so a poster is
  // never skipped for lack of art (the automated pipeline has no human to resolve gaps).
  if (out.length === 0) {
    const generic = await genericSacredArt(target).catch(() => []);
    generic.forEach(push);
    if (out.length) axisUsed = axisUsed || "generic";
  }

  return { candidates: out.slice(0, 6), axisUsed, needsManual: out.length === 0 };
}
```

- [ ] **Step 2: Verify nothing regressed**

Run: `node --test`
Expected: PASS (all existing tests still green; this is an additive wiring change).

- [ ] **Step 3: Manual network check (documented, optional in CI)**

Run: `node -e "require('./src/act-client.js').genericSacredArt({serviceKey:'x'}).then(c=>console.log(c.length, c[0] && c[0].title))"`
Expected: prints a non-zero count and a title (confirms the queries resolve against live Commons). If it prints `0`, edit `src/data/generic-sacred-art.json` to replace any dead queries with ones that return art, and re-run.

- [ ] **Step 4: Commit**

```bash
git add src/act-client.js
git commit -m "feat: never skip a service — fall back to generic sacred art"
```

---

## Task 5: `node index.js auto` command + build report

**Files:**
- Modify: `index.js`
- Test: `tests/auto.test.js`

- [ ] **Step 1: Write the failing test for orchestration order**

Create `tests/auto.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { runAuto } = require("../index.js");

test("runAuto runs parse, then images, then build, with the same services file", async () => {
  const calls = [];
  const spy = (name) => async (file) => { calls.push([name, file]); };
  await runAuto({ parse: spy("parse"), images: spy("images"), build: spy("build"), servicesFile: "/tmp/s.json" });
  assert.deepStrictEqual(calls, [
    ["parse", "/tmp/s.json"],
    ["images", "/tmp/s.json"],
    ["build", "/tmp/s.json"],
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/auto.test.js`
Expected: FAIL — `runAuto is not a function` (index.js currently exports nothing; it runs on require).

> Note: `index.js` currently executes its dispatch IIFE on load. Requiring it from a test
> would run the CLI. Step 3 guards the IIFE so the file is safe to `require`, and exports
> `runAuto`.

- [ ] **Step 3: Add `runAuto`, guard the IIFE, and export**

In `index.js`, add the `runAuto` function just above the `// ── dispatch ──` comment:

```js
// ── auto (unattended: parse → images → build, no review) ────────
async function runAuto({ parse, images, build, servicesFile }) {
  await parse(servicesFile);
  await images(servicesFile);
  await build(servicesFile);
}
```

Then change the dispatch block. Replace:

```js
// ── dispatch ────────────────────────────────────────────────────
(async () => {
  const [cmd, arg] = process.argv.slice(2);
  const servicesDefault = path.join(OUT, "services.json");
  try {
    switch (cmd) {
      case "parse": return cmdParse(arg ? path.resolve(arg) : servicesDefault);
      case "images": return await cmdImages(arg ? path.resolve(arg) : servicesDefault);
      case "review": return await cmdReview();
      case "build": return await cmdBuild(arg ? path.resolve(arg) : servicesDefault);
      default:
        console.log("Usage: node index.js <parse|images|review|build> [out/services.json]");
        process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    die(e.message);
  }
})();
```

with:

```js
// ── dispatch ────────────────────────────────────────────────────
async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const servicesDefault = path.join(OUT, "services.json");
  try {
    switch (cmd) {
      case "parse": return cmdParse(arg ? path.resolve(arg) : servicesDefault);
      case "images": return await cmdImages(arg ? path.resolve(arg) : servicesDefault);
      case "review": return await cmdReview();
      case "build": return await cmdBuild(arg ? path.resolve(arg) : servicesDefault);
      case "auto":
        return await runAuto({ parse: cmdParse, images: cmdImages, build: cmdBuild, servicesFile: servicesDefault });
      default:
        console.log("Usage: node index.js <parse|images|review|build|auto> [out/services.json]");
        process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    die(e.message);
  }
}

// Only run the CLI when invoked directly (so tests can require this file safely).
if (require.main === module) {
  main();
}

module.exports = { runAuto };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/auto.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Make `cmdBuild` write a machine-readable report**

The watcher needs to know what was built and which art each poster used (to flag generic
fallbacks in the run summary). In `index.js`, inside `async function cmdBuild`, find the
declarations near the top of the function:

```js
  const built = [], skipped = [], noAlt = [], failed = [];
  const usedGlobal = new Set();
  const LABELS = ["a", "b"];
```

Add a `report` array:

```js
  const built = [], skipped = [], noAlt = [], failed = [];
  const report = [];
  const usedGlobal = new Set();
  const LABELS = ["a", "b"];
```

Then find the success line inside the inner `for` loop, immediately after `built.push(outKey);`:

```js
          console.log(`  ✓ ${outKey}.png  ${r.width}×${r.height}${light ? "  (light bg)" : ""}  — ${picks[i].title || picks[i].occasion || ""}`);
          built.push(outKey);
```

Add a structured record right after `built.push(outKey);`:

```js
          console.log(`  ✓ ${outKey}.png  ${r.width}×${r.height}${light ? "  (light bg)" : ""}  — ${picks[i].title || picks[i].occasion || ""}`);
          built.push(outKey);
          report.push({
            outKey,
            date: t.date,
            occasion: t.occasion,
            variant: t.variant,
            source: picks[i].source,
            title: picks[i].title || picks[i].occasion || "",
            attribution: picks[i].attribution || "",
          });
```

Finally, find the end of `cmdBuild` (the summary `console.log`s after the `finally` block):

```js
  console.log(`\nBuilt ${built.length} poster(s) across ${targets.length - skipped.length} target(s) → out/.`);
  if (noAlt.length) console.log(`Only one image available (no alternate): ${noAlt.join(", ")}`);
  if (skipped.length) console.log(`Skipped (need art): ${skipped.join(", ")}`);
  if (failed.length) console.log(`Failed to render (kept going): ${failed.join(", ")}`);
}
```

Add a `build-report.json` write before the closing brace:

```js
  console.log(`\nBuilt ${built.length} poster(s) across ${targets.length - skipped.length} target(s) → out/.`);
  if (noAlt.length) console.log(`Only one image available (no alternate): ${noAlt.join(", ")}`);
  if (skipped.length) console.log(`Skipped (need art): ${skipped.join(", ")}`);
  if (failed.length) console.log(`Failed to render (kept going): ${failed.join(", ")}`);
  fs.writeFileSync(path.join(OUT, "build-report.json"), JSON.stringify({ posters: report, skipped, failed, noAlt }, null, 2));
}
```

- [ ] **Step 6: Verify the suite is still green**

Run: `node --test`
Expected: PASS (all tests).

- [ ] **Step 7: Commit**

```bash
git add index.js tests/auto.test.js
git commit -m "feat: add 'auto' command and out/build-report.json"
```

---

## Task 6: Pure automation helpers — `src/automation.js`

This task is split into focused sub-steps, each with its own test, because the helpers are
independent. All tests live in `tests/automation.test.js`.

**Files:**
- Create: `src/automation.js`
- Test: `tests/automation.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/automation.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const auto = require("../src/automation.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stb-auto-"));
}

test("contentHash is stable and differs by content", () => {
  assert.strictEqual(auto.contentHash("abc"), auto.contentHash("abc"));
  assert.notStrictEqual(auto.contentHash("abc"), auto.contentHash("abd"));
});

test("periodSlug derives YYYY-MM_Month-Month from .doc-period", () => {
  const html = `<html><body><div class="doc-period">May &amp; June 2026</div></body></html>`;
  assert.strictEqual(auto.periodSlug(html), "2026-05_May-June");
});

test("periodSlug falls back to <title> and a single month", () => {
  const html = `<html><head><title>Music List — December 2026</title></head><body></body></html>`;
  assert.strictEqual(auto.periodSlug(html), "2026-12_December");
});

test("periodSlug returns 'unknown-period' when nothing parseable", () => {
  assert.strictEqual(auto.periodSlug("<html></html>"), "unknown-period");
});

test("processed-state round-trips and detects duplicates", () => {
  const dir = tmpDir();
  const file = path.join(dir, "processed.json");
  assert.strictEqual(auto.isProcessed(file, "h1"), false);
  auto.markProcessed(file, "h1");
  assert.strictEqual(auto.isProcessed(file, "h1"), true);
  assert.strictEqual(auto.isProcessed(file, "h2"), false);
});

test("acquireLock is exclusive; releaseLock frees it", () => {
  const dir = tmpDir();
  const lock = path.join(dir, "run.lock");
  assert.strictEqual(auto.acquireLock(lock), true);
  assert.strictEqual(auto.acquireLock(lock), false, "second acquire must fail");
  auto.releaseLock(lock);
  assert.strictEqual(auto.acquireLock(lock), true, "acquire works again after release");
});

test("waitForStableSize resolves once the file stops growing", async () => {
  const dir = tmpDir();
  const f = path.join(dir, "growing.html");
  fs.writeFileSync(f, "a");
  // Append twice, then stop; with short timings the helper should resolve true.
  setTimeout(() => fs.appendFileSync(f, "bb"), 20);
  setTimeout(() => fs.appendFileSync(f, "cc"), 60);
  const ok = await auto.waitForStableSize(f, { settleMs: 60, pollMs: 20, timeoutMs: 2000 });
  assert.strictEqual(ok, true);
});

test("publishFromReport copies each poster's png and caption", () => {
  const dir = tmpDir();
  const outDir = path.join(dir, "out"); fs.mkdirSync(outDir);
  const destDir = path.join(dir, "dest");
  for (const k of ["07-06-2026-a", "07-06-2026-b"]) {
    fs.writeFileSync(path.join(outDir, k + ".png"), "png");
    fs.writeFileSync(path.join(outDir, k + ".caption.txt"), "cap");
  }
  const report = { posters: [{ outKey: "07-06-2026-a" }, { outKey: "07-06-2026-b" }] };
  const copied = auto.publishFromReport(report, { outDir, destDir });
  assert.strictEqual(copied.length, 4);
  assert.ok(fs.existsSync(path.join(destDir, "07-06-2026-a.png")));
  assert.ok(fs.existsSync(path.join(destDir, "07-06-2026-b.caption.txt")));
});

test("formatRunSummary lists counts, generic fallbacks, and failures", () => {
  const report = {
    posters: [
      { outKey: "a", occasion: "Trinity", source: "commons", title: "X", attribution: "x" },
      { outKey: "b", occasion: "St Barnabas", source: "generic", title: "Pantocrator", attribution: "y" },
    ],
    skipped: [], failed: ["c"], noAlt: ["a"],
  };
  const s = auto.formatRunSummary(report, {
    sourceFile: "music-list.html", period: "2026-05_May-June", ranAt: "2026-05-29T10:00:00Z", ok: true,
  });
  assert.match(s, /2 poster/);
  assert.match(s, /generic/i);
  assert.match(s, /Pantocrator/);
  assert.match(s, /Failed/i);
});

test("formatRunSummary renders a failure run", () => {
  const s = auto.formatRunSummary(null, {
    sourceFile: "bad.html", period: "unknown-period", ranAt: "2026-05-29T10:00:00Z",
    ok: false, error: "Could not determine the year",
  });
  assert.match(s, /FAILED/);
  assert.match(s, /Could not determine the year/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/automation.test.js`
Expected: FAIL — `Cannot find module '../src/automation.js'`.

- [ ] **Step 3: Implement `src/automation.js`**

Create `src/automation.js`:

```js
/**
 * automation.js — pure, testable helpers for the unattended watcher (scripts/watch.js).
 *
 * Nothing here talks to Google Drive: Drive for Desktop owns sync. These functions handle
 * the local-filesystem mechanics — hashing an input, deriving a per-list output folder name,
 * remembering what's been processed, serialising runs with a lockfile, waiting for a synced
 * file to finish downloading, copying the produced posters, and formatting the run summary.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cheerio = require("cheerio");

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** SHA-256 hex of a string or Buffer — identifies an input list by content. */
function contentHash(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Derive a stable output-subfolder name from the music list, e.g.
 * "May & June 2026" → "2026-05_May-June" ; "December 2026" → "2026-12_December".
 * Reads .doc-period, falling back to <title>. Returns "unknown-period" if unparseable.
 */
function periodSlug(html) {
  const $ = cheerio.load(html);
  const text = ($(".doc-period").first().text() || $("title").text() || "").replace(/\s+/g, " ").trim();
  const year = (text.match(/(\d{4})/) || [])[1];
  const found = [];
  for (const m of MONTHS) {
    const idx = text.toLowerCase().indexOf(m.toLowerCase());
    if (idx >= 0) found.push({ idx, name: m, num: MONTHS.indexOf(m) + 1 });
  }
  found.sort((a, b) => a.idx - b.idx);
  if (!year || !found.length) return "unknown-period";
  const mm = String(found[0].num).padStart(2, "0");
  const names = found.map((f) => f.name).join("-");
  return `${year}-${mm}_${names}`;
}

/** Read the processed-state map ({ hash: isoTimestamp }); {} if absent/corrupt. */
function loadProcessed(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

function isProcessed(file, hash) {
  return Object.prototype.hasOwnProperty.call(loadProcessed(file), hash);
}

function markProcessed(file, hash, ranAt) {
  const map = loadProcessed(file);
  map[hash] = ranAt || new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 2));
}

/** Exclusive lockfile via O_EXCL. Returns true if acquired, false if already held. */
function acquireLock(lockPath) {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve true once `filePath`'s size has been unchanged for `settleMs` (Drive for Desktop
 * streams downloads, so a just-appeared file may still be growing). Resolves false on timeout.
 */
async function waitForStableSize(filePath, { settleMs = 10000, pollMs = 1000, timeoutMs = 120000 } = {}) {
  const start = Date.now();
  let lastSize = -1;
  let stableSince = 0;
  for (;;) {
    let size = -1;
    try { size = fs.statSync(filePath).size; } catch { size = -1; }
    if (size >= 0 && size === lastSize) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= settleMs) return true;
    } else {
      lastSize = size;
      stableSince = 0;
    }
    if (Date.now() - start > timeoutMs) return false;
    await sleep(pollMs);
  }
}

/**
 * Copy each built poster's .png and .caption.txt from outDir into destDir (created if
 * needed). Driven by build-report.json's `posters[].outKey`. Returns the copied paths.
 */
function publishFromReport(report, { outDir, destDir }) {
  fs.mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const p of (report.posters || [])) {
    for (const ext of [".png", ".caption.txt"]) {
      const src = path.join(outDir, p.outKey + ext);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(destDir, p.outKey + ext);
      fs.copyFileSync(src, dst);
      copied.push(dst);
    }
  }
  return copied;
}

/** Human-readable run summary written into the output folder as _run-summary.txt. */
function formatRunSummary(report, { sourceFile, period, ranAt, ok, error } = {}) {
  const L = [];
  L.push("St Barnabas — automated poster run");
  L.push(`Run at:      ${ranAt}`);
  L.push(`Source list: ${sourceFile}`);
  L.push(`Period:      ${period}`);
  L.push("");
  if (!ok) {
    L.push("RESULT: FAILED");
    L.push(`Error: ${error || "unknown error"}`);
    L.push("");
    L.push("No posters were produced. The list was not marked processed, so a corrected");
    L.push("re-upload will be retried automatically.");
    return L.join("\n") + "\n";
  }
  const posters = report.posters || [];
  const generic = posters.filter((p) => p.source === "generic");
  L.push(`RESULT: OK — ${posters.length} poster(s) produced.`);
  L.push("");
  L.push("Posters:");
  for (const p of posters) {
    L.push(`  • ${p.outKey}  — ${p.occasion}  [art: ${p.source}]  ${p.title}`);
  }
  if (generic.length) {
    L.push("");
    L.push(`Generic-art fallback used for ${generic.length} poster(s):`);
    for (const p of generic) L.push(`  • ${p.outKey} — ${p.occasion}`);
  }
  if (report.failed && report.failed.length) {
    L.push("");
    L.push(`Failed to render (kept going): ${report.failed.join(", ")}`);
  }
  if (report.skipped && report.skipped.length) {
    L.push("");
    L.push(`Skipped (no art — unexpected with backstop): ${report.skipped.join(", ")}`);
  }
  return L.join("\n") + "\n";
}

module.exports = {
  contentHash,
  periodSlug,
  loadProcessed,
  isProcessed,
  markProcessed,
  acquireLock,
  releaseLock,
  waitForStableSize,
  publishFromReport,
  formatRunSummary,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/automation.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/automation.js tests/automation.test.js
git commit -m "feat: pure automation helpers (hash, period slug, lock, settle, publish, summary)"
```

---

## Task 7: The watcher entrypoint — `scripts/watch.js`

The watcher is thin wiring over Task 6's tested helpers and the `auto` command. Its loop logic
is hard to unit-test (it watches a directory and spawns a child process), so it is verified by
the documented end-to-end check in Step 3 rather than an automated test.

**Files:**
- Create: `scripts/watch.js`

- [ ] **Step 1: Implement the watcher**

Create `scripts/watch.js`:

```js
#!/usr/bin/env node
/**
 * watch.js — the unattended trigger for the always-on Mac mini, run under launchd.
 *
 * Watches config.automation.inputDir (a Google Drive for Desktop mirror) for a music-list
 * .html. When one settles, runs `node index.js auto` and publishes the produced posters +
 * captions + _run-summary.txt into config.automation.outputDir/<period>/, which Drive syncs.
 *
 * Idempotent (content-hash dedup), serialised (lockfile), and resilient (a failed run is NOT
 * marked processed, so a corrected re-upload retries). Drive sync itself is Drive's job.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const auto = require("../src/automation.js");

const ROOT = path.resolve(__dirname, "..");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const A = CFG.automation || {};
const INPUT = A.inputDir;
const OUTPUT = A.outputDir;
const SETTLE_MS = (A.settleSeconds || 10) * 1000;

const OUT = path.join(ROOT, "out");
const SAMPLE = path.join(ROOT, "samples", "music-list.html");
const PROCESSED = path.join(ROOT, "cache", "processed.json");
const LOCK = path.join(ROOT, "cache", "run.lock");
const LOG = path.join(ROOT, "cache", "watch.log");

function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}\n`;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, line);
  process.stdout.write(line);
}

function fail(msg) { log("FATAL: " + msg); process.exit(1); }

if (!INPUT || !OUTPUT) fail("config.json automation.inputDir / automation.outputDir are not set.");
if (!fs.existsSync(INPUT)) fail(`inputDir does not exist: ${INPUT} (is Drive for Desktop mirroring it?)`);

/** Run `node index.js auto` as a child; resolve { ok, error }. */
function runAuto() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "index.js"), "auto"], { cwd: ROOT });
    let stderr = "";
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => { stderr += d; process.stderr.write(d); });
    child.on("close", (code) => resolve(code === 0
      ? { ok: true }
      : { ok: false, error: (stderr.trim().split("\n").pop() || `exit ${code}`) }));
  });
}

async function process_(filePath) {
  const name = path.basename(filePath);
  if (!/\.html?$/i.test(name)) return;

  log(`detected ${name} — waiting for it to settle`);
  const settled = await auto.waitForStableSize(filePath, { settleMs: SETTLE_MS });
  if (!settled) { log(`${name} never settled — skipping for now`); return; }

  const html = fs.readFileSync(filePath, "utf8");
  const hash = auto.contentHash(html);
  if (auto.isProcessed(PROCESSED, hash)) { log(`${name} already processed (hash match) — ignoring`); return; }

  if (!auto.acquireLock(LOCK)) { log(`a run is already in progress — ${name} will be retried on next event`); return; }

  const period = auto.periodSlug(html);
  const destDir = path.join(OUTPUT, period);
  const ranAt = new Date().toISOString();
  try {
    fs.copyFileSync(filePath, SAMPLE);
    log(`running pipeline for ${name} (period ${period})`);
    const result = await runAuto();

    if (result.ok) {
      const report = JSON.parse(fs.readFileSync(path.join(OUT, "build-report.json"), "utf8"));
      const copied = auto.publishFromReport(report, { outDir: OUT, destDir });
      fs.writeFileSync(path.join(destDir, "_run-summary.txt"),
        auto.formatRunSummary(report, { sourceFile: name, period, ranAt, ok: true }));
      auto.markProcessed(PROCESSED, hash, ranAt);
      log(`OK — ${report.posters.length} poster(s), ${copied.length} file(s) → ${destDir}`);
    } else {
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, "_run-summary.txt"),
        auto.formatRunSummary(null, { sourceFile: name, period, ranAt, ok: false, error: result.error }));
      log(`FAILED — ${result.error} (not marked processed; re-upload to retry)`);
    }
  } catch (e) {
    log(`ERROR handling ${name}: ${e.message}`);
  } finally {
    auto.releaseLock(LOCK);
  }
}

// Stale lock from a previous crash: clear it on startup (we are the only watcher).
auto.releaseLock(LOCK);
log(`watching ${INPUT} → ${OUTPUT}`);

// Process anything already sitting in the folder at startup, then watch for changes.
for (const f of fs.readdirSync(INPUT)) process_(path.join(INPUT, f));
fs.watch(INPUT, (_event, filename) => {
  if (filename) process_(path.join(INPUT, filename));
});
```

- [ ] **Step 2: Verify it loads and reports missing config cleanly**

Run: `node scripts/watch.js`
Expected: exits with `FATAL: config.json automation.inputDir / automation.outputDir are not set.` (the `automation` block is added in Task 8 — this confirms the guard works).

- [ ] **Step 3: Documented end-to-end check (run after Task 8)**

After Task 8 sets real paths, simulate Drive locally:
```bash
mkdir -p /tmp/stb-in /tmp/stb-out
# Temporarily point config.automation at /tmp/stb-in and /tmp/stb-out, then:
npm run watch &        # leave it running
cp samples/music-list.html /tmp/stb-in/
# Wait ~settleSeconds + pipeline time, then:
ls /tmp/stb-out/*/     # expect *.png, *.caption.txt, _run-summary.txt in a <period>/ folder
cat /tmp/stb-out/*/_run-summary.txt
kill %1
```
Expected: a `<period>/` subfolder containing posters, captions, and a summary listing the posters and any generic-art fallbacks. Re-copying the same file logs `already processed`.

- [ ] **Step 4: Commit**

```bash
git add scripts/watch.js
git commit -m "feat: launchd watcher — trigger auto pipeline and publish to Drive mirror"
```

---

## Task 8: Config block, launchd template, and docs

**Files:**
- Modify: `config.json`
- Create: `deploy/com.stbarnabas.social.watch.plist`
- Modify: `README.md`

- [ ] **Step 1: Add the `automation` block to config.json**

In `config.json`, add an `automation` key (after `"fonts"`, before `"textColour"` — any
position is fine as long as JSON stays valid). Use the real Drive-mirror paths for this Mac;
the `<user>` / folder names are placeholders to fill in at deploy time:

```json
  "automation": {
    "inputDir": "/Users/<user>/Library/CloudStorage/GoogleDrive-<account>/My Drive/StBarnabas/music-lists-in",
    "outputDir": "/Users/<user>/Library/CloudStorage/GoogleDrive-<account>/My Drive/StBarnabas/posters-out",
    "settleSeconds": 10
  },
```

- [ ] **Step 2: Verify config.json is still valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('valid')"`
Expected: prints `valid`.

- [ ] **Step 3: Create the LaunchAgent template**

Create `deploy/com.stbarnabas.social.watch.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.stbarnabas.social.watch</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/REPLACE/WITH/ABSOLUTE/PATH/TO/stbsocial/scripts/watch.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/REPLACE/WITH/ABSOLUTE/PATH/TO/stbsocial</string>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/REPLACE/WITH/ABSOLUTE/PATH/TO/stbsocial/cache/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/REPLACE/WITH/ABSOLUTE/PATH/TO/stbsocial/cache/launchd.err.log</string>
</dict>
</plist>
```

- [ ] **Step 4: Document deployment in README.md**

Append this section to the end of `README.md`:

````markdown
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
````

- [ ] **Step 5: Run the full suite one last time**

Run: `node --test`
Expected: PASS (all tests across the three test files).

- [ ] **Step 6: Commit**

```bash
git add config.json deploy/com.stbarnabas.social.watch.plist README.md
git commit -m "feat: automation config, launchd template, and deployment docs"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** no-review unattended run (Tasks 5); never-blank generic art (Tasks 2–4);
  local-mirror trigger + publish (Tasks 6–7); per-list output subfolder (`periodSlug`,
  `publishFromReport`); `_run-summary.txt`, no email (`formatRunSummary`); config block +
  launchd + docs (Task 8); error handling — half-synced (`waitForStableSize`), unparseable
  (failed summary, not marked processed), per-image failure (existing `build`), concurrency
  (`acquireLock`).
- **`samples/music-list.html` is overwritten** by the watcher each run — this is the existing
  parser's only input path, and it is intentional. The original sample is preserved in git
  history if ever needed.
- **Network in tests:** unit tests stub the network (injected `search`/temp dirs). The two
  network-touching checks (Task 4 Step 3, Task 7 Step 3) are explicit manual steps.
- **No new runtime dependencies** — `cheerio` and Node built-ins only.
```
