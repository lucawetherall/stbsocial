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
