/**
 * targets.js — turn a parsed date object into one or more "poster targets".
 *
 * One poster per date, EXCEPT a transferred-feast date (a feast distinct from the ordinary
 * Common Worship Sunday) yields TWO variants so the user can choose which to post:
 *   - feast      → headline = the feast title, art sourced for the feast
 *   - liturgical → headline = the ordinary CW day name, art sourced for that day's readings
 *
 * Both variants carry the full day's services (complete music). Each target is fully
 * self-describing for both image sourcing (act-client) and composition (compose).
 */

const path = require("path");
const cw = require("./cw-calendar.js");
const gospelSubjects = require("./data/gospel-subjects.json").subjects;

let _overrides = null;
function occasionOverrides() {
  if (_overrides === null) {
    try { _overrides = require(path.join(process.cwd(), "config.json")).occasionOverrides || {}; }
    catch { _overrides = {}; }
  }
  return _overrides;
}

const slug = (s) =>
  String(s || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Is a feast/occasion name an *ordinary* CW Sunday/season rather than a feast/saint's day? */
function isOrdinaryName(name) {
  return /(sunday after trinity)|(sunday (of|before|next before))|(trinity sunday)|(day of pentecost)|(bible sunday)|(christ the king)|(baptism of christ)|(sunday of advent)|(sunday of christmas)|(sunday of epiphany)|(sunday of lent)|(sunday of easter)/i
    .test(name || "");
}

/** Feast art keywords (the saint/feast is the subject). */
function feastKeywords(occasion) {
  const k = cw.imageKeywordsForOccasion(occasion);
  if (k && k.keywords && k.keywords.length) return k.keywords;
  return occasion ? [occasion.replace(/^the\s+/i, "")] : [];
}

/**
 * Image-search keywords for a target. Feasts → the saint/feast subject. Ordinary Sundays →
 * the Gospel's depicted scene/parable (from the Gospel-subject map) so we search for real
 * art, not the occasion words ("Trinity" would match church buildings). Falls back to the
 * occasion text only as a last resort.
 */
function keywordsFor({ occasion, isFeast, gospelRef }) {
  if (isFeast) return feastKeywords(occasion);
  if (gospelRef && gospelSubjects[gospelRef]) return gospelSubjects[gospelRef];
  return occasion ? [occasion.replace(/^the\s+/i, "")] : [];
}

/** Build poster target(s) for one parsed date object. */
function buildTargets(dateObj) {
  const li = cw.liturgicalInfo(dateObj.date);
  const ordinaryName = li.liturgicalDayName || dateObj.occasion;

  // Manual occasion override (config.occasionOverrides) — the parish has designated this
  // date a particular feast (e.g. Corpus Christi, St Mary Magdalene). One feast poster,
  // the date's music unchanged, art sourced for the override's keywords.
  const override = occasionOverrides()[dateObj.date];
  if (override) {
    return [
      {
        ...{
          date: dateObj.date, dateDisplay: dateObj.dateDisplay, services: dateObj.services,
          scriptureRefs: li.scriptureRefs, gospelRef: li.gospelRef,
          lectionaryYear: li.lectionaryYear, season: li.season,
        },
        serviceKey: dateObj.serviceKey,
        variant: "single",
        occasion: override.occasion,
        isFeast: true,
        imageKeywords: (override.keywords && override.keywords.length)
          ? override.keywords
          : keywordsFor({ occasion: override.occasion, isFeast: true }),
        feastTags: [slug(override.occasion)],
      },
    ];
  }

  // A distinct feast among the day's stated feasts (e.g. "St Barnabas the Apostle",
  // "The Patronal Festival") — anything that isn't an ordinary Sunday/season name.
  const feastName = (dateObj.feasts || []).find((f) => f && !isOrdinaryName(f)) || null;

  const base = {
    date: dateObj.date,
    dateDisplay: dateObj.dateDisplay,
    services: dateObj.services,
    scriptureRefs: li.scriptureRefs,
    gospelRef: li.gospelRef,
    lectionaryYear: li.lectionaryYear,
    season: li.season,
  };

  if (feastName) {
    return [
      {
        ...base,
        serviceKey: `${dateObj.serviceKey}-feast`,
        variant: "feast",
        occasion: feastName,
        isFeast: true,
        imageKeywords: keywordsFor({ occasion: feastName, isFeast: true }),
        feastTags: [slug(feastName)],
      },
      {
        ...base,
        serviceKey: `${dateObj.serviceKey}-liturgical`,
        variant: "liturgical",
        occasion: ordinaryName,
        isFeast: false,
        imageKeywords: keywordsFor({ occasion: ordinaryName, isFeast: false, gospelRef: li.gospelRef }),
        feastTags: [slug(ordinaryName)],
      },
    ];
  }

  // Ordinary date → single poster, headlined with the stated (parser-wins) occasion.
  const occasion = dateObj.occasion || ordinaryName;
  const isFeast = !isOrdinaryName(occasion);
  return [
    {
      ...base,
      serviceKey: dateObj.serviceKey,
      variant: "single",
      occasion,
      isFeast,
      imageKeywords: keywordsFor({ occasion, isFeast, gospelRef: li.gospelRef }),
      feastTags: [slug(occasion)],
    },
  ];
}

/** All targets across an array of parsed date objects. */
function buildAllTargets(dateObjs) {
  return dateObjs.flatMap(buildTargets);
}

module.exports = { buildTargets, buildAllTargets, slug, isOrdinaryName };
