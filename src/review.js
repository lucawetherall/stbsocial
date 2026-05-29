/**
 * review.js — the only interactive step. One poster target at a time, present 2–3 sourced
 * candidates as a local HTML contact sheet (thumbnails + title + attribution), opened in the
 * browser so the art can actually be judged. Pick by number, reject-all (re-search with a
 * typed keyword), or skip. On approval, download the full-res image to cache/images/ and
 * append cache/manifest.json (a growing, feast-tagged, vetted library).
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const prompts = require("prompts");
const { commonsSearch, politeFetch } = require("./act-client.js");

const ROOT = process.cwd();
const CANDIDATES = path.join(ROOT, "out", "candidates.json");
const MANIFEST = path.join(ROOT, "cache", "manifest.json");
const IMAGES = path.join(ROOT, "cache", "images");
const TMP = path.join(ROOT, "cache", "contact-sheets");

function loadManifest() {
  if (fs.existsSync(MANIFEST)) return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  return {};
}
function saveManifest(m) {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

function openInBrowser(file) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(opener, [file], () => {});
}

function contactSheet(target, candidates) {
  const cards = candidates
    .map(
      (c, i) => `
      <div class="card">
        <div class="n">${i + 1}</div>
        <img src="${c.thumbUrl}" alt="">
        <div class="meta">
          <div class="title">${escapeHtml(c.title || "(untitled)")}</div>
          <div class="src">${escapeHtml(c.source)} · ${escapeHtml(c.licence || "")} · ${c.width}×${c.height}</div>
          <div class="attr">${escapeHtml(c.attribution || "")}</div>
        </div>
      </div>`,
    )
    .join("");
  const html = `<!DOCTYPE html><meta charset="utf-8"><title>${escapeHtml(target.occasion)}</title>
  <style>
    body{font-family:-apple-system,Segoe UI,sans-serif;background:#222;color:#eee;margin:0;padding:24px}
    h1{font-weight:600;font-size:20px} h2{font-weight:400;color:#aaa;font-size:14px;margin-top:2px}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px;margin-top:18px}
    .card{background:#2d2d2d;border-radius:10px;overflow:hidden;position:relative}
    .card img{width:100%;height:300px;object-fit:contain;background:#111;display:block}
    .n{position:absolute;top:8px;left:8px;background:#c0392b;color:#fff;width:30px;height:30px;border-radius:50%;
       display:flex;align-items:center;justify-content:center;font-weight:700}
    .meta{padding:12px} .title{font-weight:600} .src{color:#9ad;font-size:12px;margin:4px 0}
    .attr{color:#bbb;font-size:12px}
  </style>
  <h1>${escapeHtml(target.occasion)} — ${escapeHtml(target.dateDisplay)} <span style="color:#888">(${target.variant})</span></h1>
  <h2>Pick a number in the terminal, or reject all to search again.</h2>
  <div class="grid">${cards || "<p>No candidates found — reject to type a keyword.</p>"}</div>`;
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `${target.serviceKey}.html`);
  fs.writeFileSync(file, html);
  return file;
}

const escapeHtml = (s) =>
  String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function downloadFull(candidate, serviceKey) {
  fs.mkdirSync(IMAGES, { recursive: true });
  if (candidate.localFile) return candidate.localFile; // manifest-cached already local
  const ext = (candidate.mime || "").includes("png") ? "png" : "jpg";
  const rel = path.join("cache", "images", `${serviceKey}.${ext}`);
  const buf = Buffer.from(await (await politeFetch(candidate.fullUrl)).arrayBuffer());
  fs.writeFileSync(path.join(ROOT, rel), buf);
  return rel;
}

async function reviewTarget(entry, manifest) {
  let candidates = entry.candidates;
  for (;;) {
    const sheet = contactSheet(entry, candidates);
    openInBrowser(sheet);
    console.log(`\n  ${entry.occasion} — ${entry.dateDisplay} [${entry.variant}]`);
    candidates.forEach((c, i) =>
      console.log(`    ${i + 1}. ${c.title}  (${c.source}, ${c.licence || "?"})`),
    );

    const choices = [
      ...candidates.map((c, i) => ({ title: `${i + 1}. ${c.title}`, value: i })),
      { title: "Reject all — search a keyword", value: "search" },
      { title: "Skip this poster (needs manual image)", value: "skip" },
    ];
    const { pick } = await prompts({ type: "select", name: "pick", message: "Choose art", choices });

    if (pick === undefined || pick === "skip") return null;
    if (pick === "search") {
      const { kw } = await prompts({ type: "text", name: "kw", message: "Search keyword" });
      if (!kw) continue;
      candidates = await commonsSearch(kw, { cache: false });
      if (!candidates.length) console.log("  (no results — try another keyword)");
      continue;
    }

    const chosen = candidates[pick];
    const imageFile = await downloadFull(chosen, entry.serviceKey);
    manifest[entry.serviceKey] = {
      serviceKey: entry.serviceKey,
      variant: entry.variant,
      date: entry.date,
      occasion: entry.occasion,
      imageFile,
      attribution: chosen.attribution,
      source: chosen.source,
      sourceUrl: chosen.sourceUrl || null,
      licence: chosen.licence || null,
      feastTags: entry.feastTags || [],
    };
    saveManifest(manifest);
    console.log(`  ✓ approved → ${imageFile}`);
    return manifest[entry.serviceKey];
  }
}

async function runReview() {
  if (!fs.existsSync(CANDIDATES)) {
    throw new Error("out/candidates.json not found — run `node index.js images out/services.json` first.");
  }
  const entries = JSON.parse(fs.readFileSync(CANDIDATES, "utf8"));
  const manifest = loadManifest();

  let approved = 0, skipped = 0;
  for (const entry of entries) {
    if (manifest[entry.serviceKey]) {
      console.log(`  • ${entry.serviceKey} already approved — skipping (delete from manifest to redo).`);
      approved++;
      continue;
    }
    const result = await reviewTarget(entry, manifest);
    if (result) approved++; else skipped++;
  }
  console.log(`\nReview complete: ${approved} approved, ${skipped} awaiting manual art.`);
}

module.exports = { runReview, contactSheet };
