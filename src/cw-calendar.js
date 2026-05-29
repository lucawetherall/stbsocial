/**
 * Common Worship calendar wrapper.
 *
 * Wraps the vendored precentor engine (src/lib/lectionary/calendar.js) and adds the two
 * things it lacks: (1) "Nth Sunday after Trinity" naming (the CW *calendar* convention the
 * St Barnabas list uses, vs the engine's CoE "Proper"/date-range lectionary keys), and
 * (2) feast-transfer logic for Principal Feasts + Festivals (src/data/feasts-cw.json).
 *
 * This module is a FALLBACK and an enrichment source — the parsed music-list feast always
 * wins for what the poster displays (parser-wins). Here we supply: the ordinary liturgical
 * day name (for the "liturgical" poster variant), the CW readings (image scripture axis),
 * and art keywords for feasts.
 */

const path = require("path");
const {
  iso,
  computeEasterDate,
  computeAdventStart,
  getChurchYear,
  getLectionaryYear,
  computeLiturgicalCalendar,
  getReadings,
} = require("./lib/lectionary/calendar.js");
const { addDays, isSunday, getDay } = require("date-fns");

const feastsData = require("./data/feasts-cw.json");
let config = {};
try {
  config = require(path.join(process.cwd(), "config.json"));
} catch {
  /* config optional here */
}

const ORDINALS = [
  "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth",
  "Ninth", "Tenth", "Eleventh", "Twelfth", "Thirteenth", "Fourteenth", "Fifteenth",
  "Sixteenth", "Seventeenth", "Eighteenth", "Nineteenth", "Twentieth", "Twenty-first",
  "Twenty-second", "Twenty-third", "Twenty-fourth", "Twenty-fifth",
];

/** Parse a yyyy-MM-dd string to a local-midnight Date (TZ-stable). */
function toDate(isoStr) {
  const [y, m, d] = isoStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * "The Nth Sunday after Trinity" for a date in the after-Trinity Ordinary Time window.
 * Returns null if the date is outside that window (e.g. before Trinity or in the
 * pre-Advent "Sundays before Advent" run).
 */
function nthSundayAfterTrinity(isoStr) {
  const date = toDate(isoStr);
  const cy = getChurchYear(date);
  const easter = computeEasterDate(cy.endYear);
  const trinitySunday = addDays(easter, 56);
  const nextAdvent = computeAdventStart(cy.endYear);
  // The "Sundays before Advent" run occupies the last ~5 Sundays before Advent.
  const lastAfterTrinity = addDays(nextAdvent, -7 * 5); // 5th Sunday before Advent boundary

  if (iso(date) <= iso(trinitySunday)) return null;
  if (iso(date) >= iso(lastAfterTrinity)) return null;

  const weeks = Math.round((date.getTime() - trinitySunday.getTime()) / (7 * 86400000));
  if (weeks < 1 || weeks > ORDINALS.length) return null;
  return `The ${ORDINALS[weeks - 1]} Sunday after Trinity`;
}

/** Liturgical info for a date: ordinary day name + CW readings + lectionary year. */
function liturgicalInfo(isoStr) {
  const date = toDate(isoStr);
  const churchYear = getChurchYear(date);
  const lectionaryYear = getLectionaryYear(churchYear);
  const entries = computeLiturgicalCalendar(churchYear);
  const entry = entries.find((e) => e.date === isoStr) || null;

  // Prefer the "Nth Sunday after Trinity" calendar name where applicable; else the
  // engine's name (Advent/Lent/Easter Sundays, principal feasts, etc.).
  const trinityName = nthSundayAfterTrinity(isoStr);
  const liturgicalDayName = trinityName || (entry ? entry.name : null);

  let readings = [];
  let scriptureRefs = [];
  if (entry) {
    readings = getReadings(entry.sundayKey, lectionaryYear)
      // Drop the "Continuous"/"Related" track-label pseudo-entries.
      .filter((r) => !/^(continuous|related)$/i.test(r.reference));
    scriptureRefs = readings.map((r) => r.reference);
  }
  const gospel = readings.find((r) => r.position === "GOSPEL");

  return {
    date: isoStr,
    sundayKey: entry ? entry.sundayKey : null,
    liturgicalDayName,
    engineName: entry ? entry.name : null,
    lectionaryYear,
    season: entry ? entry.season : null,
    colour: entry ? entry.colour : null,
    readings,
    scriptureRefs,
    gospelRef: gospel ? gospel.reference : null,
  };
}

// ─── Feast transfer logic ───────────────────────────────────────

const FEAST_RANK = { PRINCIPAL_FEAST: 3, FESTIVAL: 2 };

/** Is this Sunday "privileged" (a feast may NOT displace it; the feast transfers)? */
function isPrivilegedSunday(date, churchYear) {
  if (!isSunday(date)) return false;
  const easter = computeEasterDate(churchYear.endYear);
  const ashWed = addDays(easter, -46);
  const pentecost = addDays(easter, 49);
  const adventStart = computeAdventStart(churchYear.startYear);
  const christmasDay = new Date(churchYear.startYear, 11, 25);
  const di = iso(date);
  // Sundays of Advent, Lent, and Eastertide (Easter Day → Pentecost) are privileged.
  const inAdvent = di >= iso(adventStart) && di < iso(christmasDay);
  const inLent = di >= iso(ashWed) && di < iso(easter);
  const inEaster = di >= iso(easter) && di <= iso(pentecost);
  return inAdvent || inLent || inEaster;
}

/** The next free weekday on/after `date` not already taken by another feast in `taken`. */
function nextFreeDay(date, taken) {
  let d = date;
  for (let i = 0; i < 8; i++) {
    if (!isSunday(d) && !taken.has(iso(d))) return d;
    d = addDays(d, 1);
  }
  return d;
}

/**
 * Compute observed dates for all feasts in a church year, applying CW transfers:
 * a Festival/Principal Feast that lands on a privileged Sunday is transferred to the next
 * free weekday (cascading). Returns Map<observedISO, {feast, originalISO, transferred}>.
 */
function feastObservancesForChurchYear(churchYear) {
  const result = new Map();
  const taken = new Set();
  // Resolve higher-ranked feasts first so cascades are deterministic.
  const sorted = [...feastsData.feasts].sort(
    (a, b) => (FEAST_RANK[b.rank] || 0) - (FEAST_RANK[a.rank] || 0),
  );
  for (const feast of sorted) {
    // A feast's calendar date sits in either startYear or endYear of the church year.
    for (const yr of [churchYear.startYear, churchYear.endYear]) {
      const original = new Date(yr, feast.month - 1, feast.day);
      const cy = getChurchYear(original);
      if (cy.startYear !== churchYear.startYear) continue; // not in this church year
      let observed = original;
      let transferred = false;
      if (isSunday(original) && isPrivilegedSunday(original, churchYear)) {
        observed = nextFreeDay(addDays(original, 1), taken);
        transferred = true;
      } else if (taken.has(iso(original))) {
        observed = nextFreeDay(addDays(original, 1), taken);
        transferred = true;
      }
      taken.add(iso(observed));
      result.set(iso(observed), {
        feast,
        originalISO: iso(original),
        transferred,
      });
    }
  }
  return result;
}

/** The feast (if any) observed on a given date, with transfer applied. */
function feastOnDate(isoStr) {
  const date = toDate(isoStr);
  const churchYear = getChurchYear(date);
  const observances = feastObservancesForChurchYear(churchYear);
  return observances.get(isoStr) || null;
}

// ─── Art keyword resolution ─────────────────────────────────────

const normalise = (s) =>
  (s || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();

/**
 * Image-search keywords for a parsed feast/occasion string. Tries (in order):
 *  - the church patron (config.patron) for "Patronal Festival",
 *  - a fuzzy match against feasts-cw.json names,
 *  - else null (caller falls back to the scripture axis / occasion text).
 */
function imageKeywordsForOccasion(occasionText) {
  if (!occasionText) return null;
  const norm = normalise(occasionText);

  if (/patronal/.test(norm) && config.patron && config.patron.keywords) {
    return { keywords: config.patron.keywords, matched: config.patron.name };
  }
  // Direct/substring match against the feast list (normalised both ways).
  for (const feast of feastsData.feasts) {
    const fn = normalise(feast.name);
    const fnHead = fn.split(",")[0]; // "barnabas the apostle" from "barnabas the apostle, ..."
    if (norm.includes(fnHead) || fnHead.includes(norm) || norm === fn) {
      return { keywords: feast.keywords, matched: feast.name };
    }
  }
  // Patron by name (e.g. list says "St Barnabas the Apostle").
  if (config.patron && norm.includes(normalise(config.patron.name).split(" ")[0])) {
    return { keywords: config.patron.keywords, matched: config.patron.name };
  }
  return null;
}

module.exports = {
  liturgicalInfo,
  nthSundayAfterTrinity,
  feastOnDate,
  feastObservancesForChurchYear,
  imageKeywordsForOccasion,
  toDate,
};
