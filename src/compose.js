/**
 * compose.js — build a populated poster HTML string from a poster target + chosen image.
 *
 * A "poster target" is one renderable poster: a date (one or more services), a headline
 * occasion, and one image. Transferred-feast dates yield two targets (feast / liturgical);
 * ordinary dates yield one. Music is shown in FULL and prominently (user requirement).
 *
 * Fonts, the white logo mark, and the artwork are base64-embedded so Puppeteer's
 * setContent renders them with no external/base-URL dependency.
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const TEMPLATE = path.join(ROOT, "templates", "poster.html");

let _config = null;
function config() {
  if (!_config) _config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  return _config;
}

const escapeHtml = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function dataUri(file, mime) {
  const buf = fs.readFileSync(file);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Build the @font-face CSS with base64-embedded woff2 from assets/fonts/fonts.json. */
let _fontFaces = null;
function fontFaces() {
  if (_fontFaces) return _fontFaces;
  const manifestPath = path.join(ROOT, "assets", "fonts", "fonts.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("assets/fonts/fonts.json missing — run the font fetch step first.");
  }
  const faces = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  _fontFaces = faces
    .map((f) => {
      const fmt = f.file.endsWith("woff2") ? "woff2" : "woff";
      const uri = dataUri(path.join(ROOT, f.file), `font/${fmt}`);
      return `@font-face{font-family:'${f.family}';font-style:${f.style};font-weight:${f.weight};`
        + `font-display:block;src:url(${uri}) format('${fmt}');}`;
    })
    .join("\n");
  return _fontFaces;
}

/**
 * Turn a parsed music-value html fragment into poster-clean html:
 * keep <em> italics, DROP the .sub note entirely (e.g. "Plainsong" beside a Psalm — never
 * shown on the poster), drop &nbsp; and any stray tags.
 */
function cleanValueHtml(html, text) {
  if (!html) return escapeHtml(text || "");
  let out = html;
  out = out.replace(/<span[^>]*class="sub"[^>]*>.*?<\/span>/gi, ""); // remove sub-notes (Plainsong etc.)
  out = out.replace(/<span[^>]*>(.*?)<\/span>/gi, "$1");
  out = out.replace(/&nbsp;/gi, " ");
  out = out.replace(/<(?!\/?em\b)[^>]*>/gi, ""); // keep only <em>
  return out.replace(/\s+/g, " ").replace(/\s+([.,;])/g, "$1").trim();
}

/** Build the music block HTML for the day's services. */
function musicHtml(services, { labels } = {}) {
  const wanted = labels || null; // null = all labels
  return services
    .map((svc) => {
      const head = [svc.time, svc.serviceType].filter(Boolean).join(" · ");
      const rows = svc.music
        .filter((m) => !wanted || wanted.includes(m.label))
        .map((m) => {
          const pieces = (m.pieces && m.pieces.length)
            ? m.pieces
            : [{ html: m.html, text: m.text }];
          const valueHtml = pieces
            .map((p) => `<div class="line">${cleanValueHtml(p.html, p.text)}</div>`)
            .join("");
          const isPsalm = /psalm/i.test(m.label);
          return `<div class="row${isPsalm ? " psalm" : ""}">`
            + `<div class="label">${escapeHtml(m.label)}</div>`
            + `<div class="value">${valueHtml}</div></div>`;
        })
        .join("\n");
      return `<div class="svc"><div class="svc-head">${escapeHtml(head)}</div>${rows}</div>`;
    })
    .join("\n");
}

/**
 * compose(target) → HTML string.
 * target: {
 *   occasion, dateDisplay, services[], imagePath, imageMime?, focal?, light?, musicLabels?
 * }
 */
function compose(target) {
  const cfg = config();
  const tpl = fs.readFileSync(TEMPLATE, "utf8");

  const occasion = target.occasion || "";
  const isShort = occasion.replace(/\s+/g, "").length <= 16;

  // Prefer a pre-made (downscaled) data URI from the caller; else embed the file directly.
  let imageCss = "none";
  if (target.imageDataUri) {
    imageCss = `url('${target.imageDataUri}')`;
  } else if (target.imagePath) {
    const imageMime = target.imageMime
      || (target.imagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");
    imageCss = `url('${dataUri(target.imagePath, imageMime)}')`;
  }

  // Light background → black mark (white would vanish); otherwise the white knockout.
  const logoName = target.light ? "logo-black.png" : "logo-white.png";
  let logoFile = path.join(ROOT, "assets", logoName);
  if (!fs.existsSync(logoFile)) logoFile = path.join(ROOT, "assets", "logo-white.png");
  const logoHtml = fs.existsSync(logoFile)
    ? `<img class="mark" src="${dataUri(logoFile, "image/png")}" alt="">`
    : "";

  const repl = {
    FONT_FACES: fontFaces(),
    TEXT_COLOUR: target.light ? "#2A1708" : (cfg.textColour || "#FFFFFF"),
    IMAGE_CSS: imageCss,
    FOCAL: target.focal || "center",
    LIGHT_CLASS: target.light ? "light" : "",
    LOGO_HTML: logoHtml,
    CHURCH: escapeHtml(cfg.church || ""),
    STRAP: escapeHtml(cfg.locationStrap || ""),
    OCCASION: escapeHtml(occasion),
    OCCASION_CLASS: isShort ? "caps" : "",
    DATELINE: escapeHtml(target.dateDisplay || ""),
    MUSIC_HTML: musicHtml(target.services, { labels: target.musicLabels }),
    FOOTER_HTML: (cfg.staff && cfg.staff.length)
      ? `<div class="footer">${cfg.staff
          .map((s) => `<span class="fcredit"><span class="flabel">${escapeHtml(s.role)}</span>${escapeHtml(s.name)}</span>`)
          .join("")}</div>`
      : "",
  };

  return tpl.replace(/{{(\w+)}}/g, (_, k) => (k in repl ? repl[k] : ""));
}

module.exports = { compose, fontFaces, cleanValueHtml };
