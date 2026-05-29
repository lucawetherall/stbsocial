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
