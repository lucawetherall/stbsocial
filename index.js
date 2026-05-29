#!/usr/bin/env node
/**
 * stbarnabas-social — orchestrator.
 *
 *   node index.js parse  [out/services.json]   music-list.html → date objects (canonical shape)
 *   node index.js images [out/services.json]    per target: manifest cache → ACT/Wikidata → Commons
 *   node index.js review                         interactive approval; downloads + writes manifest
 *   node index.js build                          compose + render every approved target → out/
 *
 * `parse` and `build` are non-interactive and re-runnable; `review` is the only interactive
 * step. The tool produces files for manual posting — it never posts anywhere.
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const OUT = path.join(ROOT, "out");
const CFG = () => JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));

function die(msg) {
  console.error("\n✖ " + msg + "\n");
  process.exit(1);
}
/** ISO date (yyyy-mm-dd) → UK filename date (dd-mm-yyyy). */
function ukDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}
function requireInput(file, what) {
  if (!fs.existsSync(file)) die(`Missing ${what}: ${path.relative(ROOT, file)} — place it and re-run (no guessing).`);
}

// ── parse ───────────────────────────────────────────────────────
function cmdParse(outFile) {
  const { parseMusicListFile } = require("./src/parse-musiclist.js");
  const listFile = path.join(ROOT, "samples", "music-list.html");
  requireInput(listFile, "music list");
  const dates = parseMusicListFile(listFile);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(dates, null, 2));
  console.log(`Parsed ${dates.length} date objects (${dates.reduce((n, d) => n + d.services.length, 0)} services) → ${path.relative(ROOT, outFile)}`);
}

// ── images ──────────────────────────────────────────────────────
async function cmdImages(servicesFile) {
  requireInput(servicesFile, "services.json (run `parse` first)");
  const { buildAllTargets } = require("./src/targets.js");
  const { sourceCandidates } = require("./src/act-client.js");
  const dates = JSON.parse(fs.readFileSync(servicesFile, "utf8"));
  const targets = buildAllTargets(dates);

  // Process a few targets concurrently — the per-host throttle in act-client keeps each
  // service polite, while pipelining lets Commons work proceed during Wikidata waits.
  const CONCURRENCY = 4;
  const results = new Array(targets.length);
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const i = next++;
      const t = targets[i];
      const { candidates, axisUsed, needsManual } = await sourceCandidates(t);
      console.log(`  ${t.serviceKey} (${t.occasion}) — ${candidates.length} candidate(s)${axisUsed ? " via " + axisUsed : ""}${needsManual ? " — NEEDS MANUAL" : ""}`);
      results[i] = { ...t, candidates };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  const entries = results;
  const needManual = entries.filter((e) => !e.candidates.length).map((e) => e.serviceKey);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "candidates.json"), JSON.stringify(entries, null, 2));
  console.log(`\nWrote ${entries.length} targets → out/candidates.json`);
  if (needManual.length) console.log(`Awaiting manual art: ${needManual.join(", ")}`);
}

// ── review ──────────────────────────────────────────────────────
async function cmdReview() {
  const { runReview } = require("./src/review.js");
  await runReview();
}

// ── build ───────────────────────────────────────────────────────
async function detectLight(imagePath) {
  // Sample mean luminance of the bottom 45% (where the music sits). Light → dark text.
  const sharp = require("sharp");
  const meta = await sharp(imagePath).metadata();
  const top = Math.floor(meta.height * 0.55);
  const region = { left: 0, top, width: meta.width, height: meta.height - top };
  const { data, info } = await sharp(imagePath).extract(region).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const mean = sum / data.length;
  return mean > 175; // bright lower band → use the light-background treatment
}

function buildCaption(target, attribution) {
  const cfg = CFG();
  const lines = [];
  lines.push(target.occasion);
  lines.push(target.dateDisplay);
  lines.push("");
  for (const s of target.services) {
    lines.push(`${[s.time, s.serviceType].filter(Boolean).join(" — ")}`);
    for (const m of s.music) {
      const pieces = (m.pieces && m.pieces.length) ? m.pieces.map((p) => p.text) : [m.text];
      // drop the Plainsong sub-note like the poster; one piece per line.
      const clean = pieces.map((p) => p.replace(/\s+plainsong\b/i, "").trim());
      lines.push(`  ${m.label}: ${clean[0]}`);
      for (let i = 1; i < clean.length; i++) lines.push(`  ${" ".repeat(m.label.length + 1)} ${clean[i]}`);
    }
    lines.push("");
  }
  lines.push(`${cfg.church} · ${cfg.locationStrap}`);
  lines.push("");
  lines.push(`Artwork: ${attribution}`);
  if (cfg.usage) lines.push(`(Image used for non-commercial liturgical purposes with attribution.)`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Downscale an image to a sensible embed size (the 2× canvas is 2160×2700) → JPEG data URI. */
async function embedImage(imagePath) {
  const sharp = require("sharp");
  const buf = await sharp(imagePath)
    .rotate()
    .resize({ width: 2200, height: 2750, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 84 })
    .toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

/** Ensure a pick's image is on disk; download from fullUrl if needed. Returns abs path. */
async function ensureLocalImage(pick, key) {
  const { politeFetch } = require("./src/act-client.js");
  if (pick.imageFile && fs.existsSync(path.join(ROOT, pick.imageFile))) return path.join(ROOT, pick.imageFile);
  if (pick.localFile && fs.existsSync(pick.localFile)) return pick.localFile;
  fs.mkdirSync(path.join(ROOT, "cache", "images"), { recursive: true });
  const ext = (pick.mime || "").includes("png") ? "png" : "jpg";
  const rel = path.join("cache", "images", `${key}.${ext}`);
  const buf = Buffer.from(await (await politeFetch(pick.fullUrl)).arrayBuffer());
  fs.writeFileSync(path.join(ROOT, rel), buf);
  return path.join(ROOT, rel);
}

/**
 * Resolve up to 2 DISTINCT image picks per target: any human-approved manifest entry first,
 * then the auto-sourced candidates. Each pick → { fullUrl|imageFile, mime, attribution, ... }.
 */
function resolvePicks(target, candidateEntry, manifestEntry, usedGlobal) {
  const picks = [];
  const seen = new Set();
  // A pick is identified by BOTH its file (imageFile/fullUrl) AND its artwork identity
  // (artist+title). It's a duplicate if EITHER has already been used — this catches both
  // different scans of one painting and the same file attributed to two artists.
  const idsOf = (p) => [p.imageFile, p.fullUrl, p.artworkKey].filter(Boolean);
  const isDup = (p) => idsOf(p).some((id) => seen.has(id) || (usedGlobal && usedGlobal.has(id)));
  const add = (p) => {
    if (picks.length >= 2 || isDup(p)) return;
    idsOf(p).forEach((id) => seen.add(id));
    picks.push(p);
  };
  if (manifestEntry && manifestEntry.imageFile) add(manifestEntry);
  for (const c of (candidateEntry && candidateEntry.candidates) || []) add(c);
  // mark chosen files+artworks as used so other posters can't repeat them
  if (usedGlobal) picks.forEach((p) => idsOf(p).forEach((id) => usedGlobal.add(id)));
  return picks;
}

async function cmdBuild(servicesFile) {
  requireInput(servicesFile, "services.json (run `parse` first)");
  const candPath = path.join(OUT, "candidates.json");
  requireInput(candPath, "candidates.json (run `images` first)");
  const { buildAllTargets } = require("./src/targets.js");
  const { compose } = require("./src/compose.js");
  const { renderHtmlToPng, closeBrowser } = require("./src/render.js");

  const manifestPath = path.join(ROOT, "cache", "manifest.json");
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
  const candById = {};
  for (const e of JSON.parse(fs.readFileSync(candPath, "utf8"))) candById[e.serviceKey] = e;
  const dates = JSON.parse(fs.readFileSync(servicesFile, "utf8"));
  const targets = buildAllTargets(dates);

  fs.mkdirSync(OUT, { recursive: true });
  const built = [], skipped = [], noAlt = [], failed = [];
  const report = [];
  const usedGlobal = new Set();
  const LABELS = ["a", "b"];
  try {
    for (const t of targets) {
      const picks = resolvePicks(t, candById[t.serviceKey], manifest[t.serviceKey], usedGlobal);
      if (!picks.length) { skipped.push(t.serviceKey); continue; }
      if (picks.length < 2) noAlt.push(t.serviceKey);
      const variantTag = t.variant && t.variant !== "single" ? `-${t.variant}` : "";
      for (let i = 0; i < picks.length; i++) {
        // Output filename uses the UK date (dd-mm-yyyy); serviceKey stays ISO internally.
        const outKey = `${ukDate(t.date)}${variantTag}-${LABELS[i]}`;
        try {
          const imagePath = await ensureLocalImage(picks[i], `${t.serviceKey}-${LABELS[i]}`);
          const imageDataUri = await embedImage(imagePath);
          const light = await detectLight(imagePath);
          const html = compose({
            occasion: t.occasion, dateDisplay: t.dateDisplay, services: t.services,
            imageDataUri, focal: t.focal || "center", light,
          });
          const r = await renderHtmlToPng(html, path.join(OUT, `${outKey}.png`));
          fs.writeFileSync(path.join(OUT, `${outKey}.caption.txt`), buildCaption(t, picks[i].attribution));
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
        } catch (e) {
          // One bad image must not abort the whole run.
          console.log(`  ✖ ${outKey} failed: ${e.message}`);
          failed.push(outKey);
        }
      }
    }
  } finally {
    await closeBrowser();
  }
  console.log(`\nBuilt ${built.length} poster(s) across ${targets.length - skipped.length} target(s) → out/.`);
  if (noAlt.length) console.log(`Only one image available (no alternate): ${noAlt.join(", ")}`);
  if (skipped.length) console.log(`Skipped (need art): ${skipped.join(", ")}`);
  if (failed.length) console.log(`Failed to render (kept going): ${failed.join(", ")}`);
  fs.writeFileSync(path.join(OUT, "build-report.json"), JSON.stringify({ posters: report, skipped, failed, noAlt }, null, 2));
}

// ── auto (unattended: parse → images → build, no review) ────────
async function runAuto({ parse, images, build, servicesFile }) {
  await parse(servicesFile);
  await images(servicesFile);
  await build(servicesFile);
}

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
