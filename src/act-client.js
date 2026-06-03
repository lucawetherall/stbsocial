/**
 * act-client.js — multi-source, never-give-up sacred-art sourcing.
 *
 * The legacy ACT search site (diglib.library.vanderbilt.edu/act-search.pl) is bot-walled
 * (403) and mid-migration, so we reach ACT's *curated* artworks the stable way: via
 * Wikidata (ACT records carry property P9092) → Wikimedia Commons images (free-licensed,
 * with creator/licence). Tiered chain per poster target:
 *
 *   1. manifest cache  — a previously approved, feast-tagged image
 *   2. ACT via Wikidata — items with P9092 depicting the occasion's subject
 *   3. Wikimedia Commons — art-only keyword search backstop (paintings/icons/frescoes…)
 *
 * (A future tier could fold in artandtheology.org's RCL-keyed "Artful Devotion" curation
 * as a relevance signal, resolving named works to Commons; not implemented yet.)
 *
 * Every candidate carries an exact, source-appropriate attribution; credits are never
 * fabricated. Queries are cached (cache/queries/), rate-limited (~1 req/2s), and sent with
 * a descriptive User-Agent (Wikimedia enforces a UA policy).
 *
 * Licence/scope: St Barnabas liturgical announcements only (non-commercial). Commons hosts
 * only *free* licences, but this tool restricts further to ones Commons labels **public
 * domain or CC0** — CC BY / CC BY-SA and other still-copyrighted free licences are rejected
 * (see `isOutOfCopyright`, which also notes the UK-vs-US PD limitation). Attribution is still
 * recorded in the caption file (courtesy for PD/CC0), never burned into the image.
 */

const fs = require("fs");
const path = require("path");
const cw = require("./cw-calendar.js");

const ROOT = process.cwd();
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const UA = CFG.userAgent || "stbarnabas-social/0.1";
const QCACHE = path.join(ROOT, "cache", "queries");
const MANIFEST = path.join(ROOT, "cache", "manifest.json");

const COMMONS = "https://commons.wikimedia.org/w/api.php";
const WDQS = "https://query.wikidata.org/sparql";

const MIN_SHORT_SIDE = 1080;

// Art-only ALLOW-LIST: a Commons candidate is accepted only if its title or categories
// mark it as an illustrated artwork (painting, icon, fresco, mosaic, illumination, etc.).
// This excludes photographs (of buildings, people, objects) by construction — the user
// wants illustrated sacred art only. (A photographic *reproduction of a painting* still
// passes, because its categories say "Paintings of…".)
const ARTWORK = /\b(painting|paintings|oil on|tempera|panel painting|icon|icons|fresco|frescoes|altarpiece|retable|mosaic|mosaics|illumination|illuminated|miniature|manuscript|triptych|diptych|stained.?glass|tapestry|engraving|etching|woodcut|drawing|drawings|watercolou?r|iconography|holy card|prayer card)\b/i;
// Hard reject even if something slips through: obvious non-art.
const REJECT_TITLE = /\bphotograph|\bphoto\b|\(IA |commentary|\bmap\b|diagram|aerial|panorama|gravestone|headstone|floor ?plan|\bplan of\b|postcard of a (church|building)/i;

// PUBLIC-DOMAIN / CC0 GATE. Wikimedia Commons hosts only *free* licences, but "free" is not
// the same as "out of copyright": CC BY / CC BY-SA works are still under copyright and carry
// attribution (and, for SA, share-alike) obligations. This gate rejects those, so posting a
// poster never depends on getting a licence's conditions right.
//
// `LicenseShortName` (from Commons extmetadata) is the per-file value we test. It is usually
// the human string "Public domain" or "CC0"; CC-licensed files render as e.g. "CC BY-SA 4.0".
// We require an explicit PD/CC0 signal AND the absence of any attribution/share-alike/non-free
// token, so a mixed or ambiguous licence is rejected.
//
// KNOWN LIMITATION (UK vs US). This trusts Commons' "Public domain" label; it does NOT
// independently verify UK status (life of the artist + 70 years). US-only PD files
// (PD-US-no-notice / not-renewed / pre-1929-published) report the same plain "Public domain"
// string yet can still be in UK copyright. We accept that residual risk deliberately: the art
// this tool sources is centuries-old sacred work (artists long dead), where UK and US PD
// coincide. Tighten with a Wikidata P570 death-date check if that ever stops holding.
const PD_OR_CC0 = /\b(public domain|public domain mark|pd-?art|pd-?old|pd-?mark|cc0|cc-?zero)\b/i;
const RESTRICTED_LICENCE = /\b(by[- ]?sa|by[- ]?nc|by[- ]?nd|cc[- ]?by\b|attribution|share[- ]?alike|gfdl|free art license|\bfal\b|gnu|all rights reserved|fair use|non[- ]?free)\b/i;

/** True only for licences that are unambiguously public domain or CC0 (out of copyright). */
function isOutOfCopyright(licence) {
  const s = String(licence == null ? "" : licence);
  if (RESTRICTED_LICENCE.test(s)) return false; // any attribution / share-alike / non-free clause → reject
  return PD_OR_CC0.test(s);                      // accept only an explicit PD or CC0 signal
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-host throttling — Commons read API tolerates a faster cadence than the Wikidata
// Query Service. Each host has its own minimum gap and its own serialised queue, so the
// two services don't slow each other down. 429 responses are honoured via Retry-After.
const HOST_MIN_MS = {
  "commons.wikimedia.org": 300,
  "upload.wikimedia.org": 150,
  "query.wikidata.org": 800,
  default: 500,
};
const _hostChain = {}; // host → promise chain (serialises + spaces requests per host)

function hostOf(url) {
  try { return new URL(url).host; } catch { return "default"; }
}

async function politeFetch(url, opts = {}) {
  const host = hostOf(url);
  const minMs = HOST_MIN_MS[host] || HOST_MIN_MS.default;
  // Queue this request behind the host's previous one, spaced by minMs.
  const prev = _hostChain[host] || Promise.resolve(0);
  let release;
  _hostChain[host] = new Promise((r) => { release = r; });
  const lastAt = await prev;
  const wait = minMs - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);

  try {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) } });
        if (res.status === 429) {
          const ra = parseInt(res.headers.get("retry-after") || "", 10);
          await sleep(Number.isFinite(ra) ? ra * 1000 : 2000 * (attempt + 1)); // honour Retry-After
          throw new Error("HTTP 429");
        }
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await sleep(700 * (attempt + 1));
      }
    }
    throw lastErr;
  } finally {
    release(Date.now());
  }
}

function cacheKey(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}
function readQCache(key) {
  const f = path.join(QCACHE, key + ".json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  return null;
}
function writeQCache(key, data) {
  fs.mkdirSync(QCACHE, { recursive: true });
  fs.writeFileSync(path.join(QCACHE, key + ".json"), JSON.stringify(data, null, 2));
}

const stripHtml = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/**
 * Identity of the underlying ARTWORK (not the file), so two scans of the same painting
 * (e.g. "… - Walters 372505" vs "… - Google Art Project") collapse to one. Built from the
 * artist + a normalised core title with source/museum/ID suffixes stripped.
 */
function artworkKey({ artist, title }) {
  let t = String(title || "").toLowerCase();
  t = t.replace(
    /\b(google art project|walters|wga|the yorck project|yorck project|hermitage|national trust|metropolitan|met museum|louvre|rijksmuseum|wikimedia commons|wikidata|web gallery of art|national gallery|google cultural institute|art project|museum)\b/gi,
    "",
  );
  t = t.replace(/\d+/g, "").replace(/[^a-z ]/gi, " ").replace(/\s+/g, " ").trim();
  const a = String(artist || "").toLowerCase().replace(/[^a-z]/g, "");
  return (a ? a + "|" : "") + t;
}

// ─── Tier 4: Wikimedia Commons keyword search ───────────────────
async function commonsSearch(query, { cache = true } = {}) {
  const key = "commons-" + cacheKey(query);
  if (cache) { const c = readQCache(key); if (c) return c; }

  // One request: search + imageinfo together via generator=search (halves round-trips).
  const url = `${COMMONS}?action=query&format=json`
    + `&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=15`
    + `&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=600`;
  const ii = await (await politeFetch(url)).json();

  const candidates = [];
  const pages = Object.values(ii.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  for (const p of pages) {
    const info = p.imageinfo && p.imageinfo[0];
    if (!info) continue;
    if (Math.min(info.width, info.height) < MIN_SHORT_SIDE) continue; // quality gate
    if (!/jpeg|png/.test(info.mime)) continue;                        // drop pdf/svg/tif
    const em = info.extmetadata || {};
    const artist = stripHtml(em.Artist?.value);
    const objName = stripHtml(em.ObjectName?.value) || stripHtml(em.ImageDescription?.value);
    const categories = stripHtml(em.Categories?.value).replace(/\|/g, " ");
    const licence = stripHtml(em.LicenseShortName?.value) || "see source";
    const credit = stripHtml(em.Credit?.value);
    if (!isOutOfCopyright(licence)) continue; // out-of-copyright only — reject CC BY/BY-SA/etc.
    const fileTitle = p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "");
    const displayTitle = (objName && objName.length < 90 ? objName : fileTitle);
    const haystack = `${fileTitle} ${objName} ${categories}`;
    // Art only: must read as an illustrated artwork, and must not be an obvious non-art file.
    if (!ARTWORK.test(haystack) || REJECT_TITLE.test(haystack)) continue;
    candidates.push({
      source: "commons",
      title: displayTitle,
      artist: artist || null,
      thumbUrl: info.thumburl || info.url,
      fullUrl: info.url,
      mime: info.mime,
      width: info.width, height: info.height,
      licence,
      attribution: buildAttribution({ artist, title: displayTitle, licence, credit, source: "Wikimedia Commons" }),
      sourceUrl: info.descriptionurl,
      artworkKey: artworkKey({ artist, title: displayTitle }),
    });
  }
  if (cache) writeQCache(key, candidates);
  return candidates;
}

// ─── Tier 2: ACT via Wikidata (P9092) depicting a subject ───────
// Resolve a subject label → Wikidata items that have an ACT ID (P9092) and depict (P180)
// something matching the subject, with an image (P18). Returns Commons-resolved candidates.
async function wikidataActSearch(subjectLabel, { cache = true } = {}) {
  const key = "wd-act-" + cacheKey(subjectLabel);
  if (cache) { const c = readQCache(key); if (c) return c; }

  // Items depicting a subject whose label matches, that also carry an ACT ID, with an image.
  const sparql = `SELECT ?item ?itemLabel ?image ?creatorLabel WHERE {
    ?item wdt:P9092 ?actId .
    ?item wdt:P18 ?image .
    ?item wdt:P180 ?subject .
    ?subject rdfs:label ?subjLabel . FILTER(LANG(?subjLabel)="en")
    FILTER(CONTAINS(LCASE(?subjLabel), "${subjectLabel.toLowerCase().replace(/"/g, "")}"))
    OPTIONAL { ?item wdt:P170 ?creator . }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  } LIMIT 8`;
  let rows = [];
  try {
    const res = await politeFetch(`${WDQS}?query=${encodeURIComponent(sparql)}&format=json`, {
      headers: { Accept: "application/sparql-results+json" },
    });
    const j = await res.json();
    rows = j.results?.bindings || [];
  } catch {
    if (cache) writeQCache(key, []);
    return [];
  }

  const candidates = [];
  for (const r of rows) {
    const commonsFile = decodeURIComponent((r.image.value.split("/Special:FilePath/")[1] || r.image.value.split("/").pop()));
    const meta = await commonsFileInfo("File:" + commonsFile.replace(/^File:/, ""));
    if (!meta) continue;
    if (Math.min(meta.width, meta.height) < MIN_SHORT_SIDE) continue;
    if (!isOutOfCopyright(meta.licence)) continue; // out-of-copyright only (see commonsSearch)
    const artist = stripHtml(r.creatorLabel?.value) || meta.artist;
    candidates.push({
      source: "act",
      title: stripHtml(r.itemLabel?.value) || meta.title,
      artist: artist || null,
      thumbUrl: meta.thumbUrl,
      fullUrl: meta.fullUrl,
      mime: meta.mime,
      width: meta.width, height: meta.height,
      licence: meta.licence,
      attribution: buildAttribution({
        artist, title: stripHtml(r.itemLabel?.value) || meta.title,
        licence: meta.licence, source: "Art in the Christian Tradition / Wikimedia Commons",
      }),
      sourceUrl: meta.sourceUrl,
      artworkKey: artworkKey({ artist, title: stripHtml(r.itemLabel?.value) || meta.title }),
    });
  }
  if (cache) writeQCache(key, candidates);
  return candidates;
}

/** imageinfo for a single Commons File: title. */
async function commonsFileInfo(fileTitle) {
  const url = `${COMMONS}?action=query&format=json&prop=imageinfo`
    + `&iiprop=url|size|mime|extmetadata&iiurlwidth=600&titles=${encodeURIComponent(fileTitle)}`;
  try {
    const j = await (await politeFetch(url)).json();
    const p = Object.values(j.query?.pages || {})[0];
    const info = p?.imageinfo?.[0];
    if (!info) return null;
    const em = info.extmetadata || {};
    return {
      title: fileTitle.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, ""),
      artist: stripHtml(em.Artist?.value) || null,
      thumbUrl: info.thumburl || info.url,
      fullUrl: info.url,
      mime: info.mime,
      width: info.width, height: info.height,
      licence: stripHtml(em.LicenseShortName?.value) || "see source",
      sourceUrl: info.descriptionurl,
    };
  } catch {
    return null;
  }
}

function buildAttribution({ artist, title, licence, credit, source }) {
  const bits = [];
  if (title) bits.push(`“${title}”`);
  if (artist) bits.push(`by ${artist}`);
  let s = bits.join(" ");
  if (s) s += ".";
  const tail = [source, licence].filter(Boolean).join(", ");
  return [s, tail ? `Source: ${tail}.` : "", credit && !artist ? credit : ""]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

// ─── manifest cache (tier 1) ────────────────────────────────────
function readManifest() {
  if (fs.existsSync(MANIFEST)) return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  return {};
}
function manifestCandidate(feastTags) {
  const man = readManifest();
  for (const entry of Object.values(man)) {
    if (!entry.feastTags || !entry.imageFile) continue;
    if (entry.feastTags.some((t) => feastTags.includes(t))) {
      const file = path.join(ROOT, entry.imageFile);
      if (!fs.existsSync(file)) continue;
      // Skip a cached pick only if its recorded licence is affirmatively non-PD/CC0; entries
      // that predate licence-recording (null) were human-approved, so keep offering them.
      if (entry.licence && !isOutOfCopyright(entry.licence)) continue;
      return {
        source: "manifest",
        title: entry.occasion || entry.feastTags[0],
        artist: null,
        thumbUrl: "file://" + file,
        fullUrl: "file://" + file,
        localFile: entry.imageFile,
        mime: entry.imageFile.endsWith(".png") ? "image/png" : "image/jpeg",
        licence: entry.licence || null,
        attribution: entry.attribution,
        sourceUrl: entry.sourceUrl,
        feastTags: entry.feastTags,
      };
    }
  }
  return null;
}

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
  // XOR-fold the hash to spread bits before reducing to avoid collisions on small arrays.
  const raw = strHash(target.serviceKey || target.occasion || "");
  const folded = (raw ^ (raw >>> 13) ^ (raw >>> 7)) >>> 0;
  const queries = rotate(GENERIC_QUERIES, folded);
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

/**
 * Source 2–3 candidates for a poster target. `target` carries:
 *   { occasion, isFeast, scriptureRefs, gospelRef, imageKeywords, feastTags }
 * Returns { candidates: [...], axisUsed, needsManual }.
 */
async function sourceCandidates(target) {
  const out = [];
  const feastTags = target.feastTags || [];

  // Tier 1 — manifest cache (offered first)
  const cached = manifestCandidate(feastTags);
  if (cached) out.push(cached);

  const seen = new Set();
  const idsOf = (f) => [f.fullUrl, f.artworkKey].filter(Boolean);
  const push = (f) => {
    if (out.length >= 6) return;
    const ids = idsOf(f);
    // Duplicate if the same FILE (url) OR the same ARTWORK (artist+title) was already taken.
    if (!ids.length || ids.some((id) => seen.has(id))) return;
    ids.forEach((id) => seen.add(id));
    out.push(f);
  };
  let axisUsed = null;
  const subjectKeywords = (target.imageKeywords || []).filter(Boolean);

  // Tier 2 — ACT via Wikidata, tried for ALL subject keywords first (curated art wins).
  for (const kw of subjectKeywords) {
    if (out.length >= 6) break;
    const wd = await wikidataActSearch(kw).catch(() => []);
    if (wd.length) axisUsed = axisUsed || "act";
    wd.forEach(push);
  }

  // Tier 4 — Commons fill: subject keywords → gospel theme → occasion, until we have 3.
  const commonsQueries = [
    ...subjectKeywords,
    target.gospelRef ? gospelTheme(target.gospelRef) : null,
    target.occasion ? target.occasion.replace(/^the\s+/i, "") : null,
  ].filter(Boolean);
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

/** Crude scripture→theme: keep the book + a sensible keyword for searching. */
function gospelTheme(ref) {
  // e.g. "Matthew 9.9-13,18-26" → "Matthew gospel" ; callers may refine.
  const book = (ref.match(/^([1-3]?\s?[A-Za-z]+)/) || [])[1] || ref;
  return `${book.trim()} gospel scene`;
}

module.exports = {
  sourceCandidates,
  commonsSearch,
  wikidataActSearch,
  commonsFileInfo,
  readManifest,
  politeFetch,
  buildAttribution,
  genericSacredArt,
  isOutOfCopyright,
};
