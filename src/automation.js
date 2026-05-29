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
