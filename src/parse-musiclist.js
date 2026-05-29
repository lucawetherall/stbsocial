/**
 * Parse the St Barnabas music-list HTML into the canonical one-object-per-DATE shape.
 *
 * Real markup (see samples/music-list.html): one <article class="service"> per service,
 * with a left .service-when (date + time) and right .service-body (feast, type, and a
 * <dl class="music-list"> of .music-label / .music-value pairs). Several services may
 * share a date; they are grouped into a single date object with a services[] array.
 *
 * Uses cheerio. British English throughout.
 */

const fs = require("fs");
const cheerio = require("cheerio");

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/** "7th"/"21st" → 7 / 21 ; tolerant of the <sup> having been flattened to text. */
function parseDayNumber(text) {
  const m = text.match(/(\d{1,2})\s*(?:st|nd|rd|th)?/i);
  return m ? parseInt(m[1], 10) : null;
}

function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

/** Collapse whitespace and trim. */
const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();

/**
 * Pull the document period year, e.g. ".doc-period" = "June & July 2026" → 2026.
 * Falls back to the <title> if needed.
 */
function extractYear($) {
  const period = tidy($(".doc-period").first().text());
  let m = period.match(/(\d{4})/);
  if (m) return parseInt(m[1], 10);
  m = tidy($("title").text()).match(/(\d{4})/);
  if (m) return parseInt(m[1], 10);
  throw new Error("Could not determine the year from .doc-period or <title>.");
}

/**
 * Parse a single .service article into a service object (date parts kept separately so
 * the caller can group by date).
 */
function parseService($, el, year) {
  const $el = $(el);

  const dateText = tidy($el.find(".service-when .service-date").text());
  const timeText = tidy($el.find(".service-when .service-time").text());

  // Date → ISO + display
  const day = parseDayNumber(dateText);
  const monthMatch = dateText.match(
    /(January|February|March|April|May|June|July|August|September|October|November|December)/i,
  );
  const weekdayMatch = dateText.match(
    /(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/i,
  );
  if (!day || !monthMatch) {
    throw new Error(`Could not parse a date from service-date: "${dateText}"`);
  }
  const month = MONTHS[monthMatch[1].toLowerCase()];
  const dateObj = new Date(year, month, day);
  const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const weekday = weekdayMatch
    ? weekdayMatch[1].charAt(0).toUpperCase() + weekdayMatch[1].slice(1).toLowerCase()
    : dateObj.toLocaleDateString("en-GB", { weekday: "long" });
  const monthName = monthMatch[1].charAt(0).toUpperCase() + monthMatch[1].slice(1).toLowerCase();
  const dateDisplay = `${weekday} ${day}${ordinalSuffix(day)} ${monthName}`;

  // Feast: keep the bracketed sub-note (e.g. "(observed early)") as a separate field.
  const $feast = $el.find(".service-body .service-feast").first();
  let feast = "";
  let feastNote = "";
  if ($feast.length) {
    const $sub = $feast.find(".sub").first();
    if ($sub.length) {
      feastNote = tidy($sub.text()).replace(/^\(|\)$/g, "");
      $sub.remove();
    }
    feast = tidy($feast.text());
  }

  const serviceType = tidy($el.find(".service-body .service-type").text());

  // Music pairs: label → value (text + html). Adjacent label/value divs in the <dl>.
  const music = [];
  $el.find(".service-body .music-list .music-label").each((_, lab) => {
    const $lab = $(lab);
    const $val = $lab.nextAll(".music-value").first();
    if (!$val.length) return;
    const label = tidy($lab.text());
    // A value may list several pieces separated by <br> (e.g. two anthems). Keep them as
    // discrete pieces so the poster can put each on its own line (no slash-joining).
    const rawHtml = $val.html() || "";
    const pieces = rawHtml
      .split(/<br\s*\/?>/i)
      .map((p) => {
        const $t = cheerio.load(`<div>${p}</div>`);
        return { html: tidy(p), text: tidy($t("div").text()) };
      })
      .filter((p) => p.text);
    music.push({
      label,
      pieces,
      text: pieces.map((p) => p.text).join("; "),       // caption/plain fallback
      html: pieces.map((p) => p.html).join("<br>"),     // preserved for completeness
    });
  });

  // Convenience accessors for known labels (case-insensitive, singular/plural tolerant).
  const find = (re) => music.find((m) => re.test(m.label));
  const psalmEntry = find(/^psalm/i);
  const settingEntry = find(/^setting/i);
  const anthemEntry = find(/^anthem/i);

  return {
    _iso: iso,
    _dateDisplay: dateDisplay,
    _weekday: weekday,
    time: timeText,
    serviceType,
    feast,
    feastNote,
    psalm: psalmEntry ? psalmEntry.text : null,
    setting: settingEntry ? settingEntry.text : null,
    settingHtml: settingEntry ? settingEntry.html : null,
    anthem: anthemEntry ? anthemEntry.text : null,
    music, // full ordered list (Introit, Responses, Canticles, etc.)
  };
}

/** Parse the music-list HTML string → array of date objects (canonical shape). */
function parseMusicListHtml(html) {
  const $ = cheerio.load(html);
  const year = extractYear($);

  const services = [];
  $("article.service").each((_, el) => services.push(parseService($, el, year)));

  if (services.length === 0) {
    throw new Error("No <article class=\"service\"> blocks found — markup may have changed.");
  }

  // Group by date, preserving document order of both dates and services.
  const byDate = new Map();
  for (const svc of services) {
    if (!byDate.has(svc._iso)) {
      byDate.set(svc._iso, {
        serviceKey: svc._iso,
        date: svc._iso,
        dateDisplay: svc._dateDisplay,
        occasion: null, // headline; set below from the principal service's feast
        feasts: [], // every distinct feast across the date's services
        lectionaryRefs: [],
        services: [],
      });
    }
    const dateObj = byDate.get(svc._iso);
    const clean = { ...svc };
    delete clean._iso;
    delete clean._dateDisplay;
    delete clean._weekday;
    dateObj.services.push(clean);
    if (svc.feast && !dateObj.feasts.includes(svc.feast)) dateObj.feasts.push(svc.feast);
  }

  // Headline occasion = the first (principal/morning) service's feast, if any.
  for (const dateObj of byDate.values()) {
    const firstFeast = dateObj.services.map((s) => s.feast).find(Boolean);
    dateObj.occasion = firstFeast || null;
  }

  return Array.from(byDate.values());
}

/** Parse a music-list HTML file path → array of date objects. */
function parseMusicListFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Music list not found at ${filePath}. Place the real file there before parsing.`);
  }
  return parseMusicListHtml(fs.readFileSync(filePath, "utf8"));
}

module.exports = { parseMusicListHtml, parseMusicListFile, ordinalSuffix };
