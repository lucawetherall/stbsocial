/**
 * Liturgical calendar engine — Common Worship.
 *
 * Vendored from the `precentor` app (~/Documents/GitHub/precentor,
 * src/lib/lectionary/calendar.ts), ported to plain CommonJS. The lectionary data
 * (src/data/lectionary-coe.json) is scraped from the Church of England Common Worship
 * lectionary. Easter computation uses Oudin's method per oremus.org/easter/computus.
 *
 * Computes all Sundays and major feasts for a given church year, returning entries that
 * map to keys in lectionary-coe.json. Feast-transfer logic lives in ../../cw-calendar.js.
 *
 * TZ note: all Date construction is local-midnight and all comparisons are done on
 * `yyyy-MM-dd` strings (see iso()), so results are timezone-stable.
 */

const { addDays, format, eachDayOfInterval, isSunday, getDay } = require("date-fns");
const lectionaryData = require("../../data/lectionary-coe.json");

/** Local ISO date (yyyy-MM-dd) — the only thing we ever compare on. */
function iso(date) {
  return format(date, "yyyy-MM-dd");
}

// ─── Easter computation (Oudin's method) ────────────────────────
function computeEasterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

/**
 * Advent Sunday (start of church year): the Sunday nearest 30 November,
 * always between 27 November and 3 December.
 */
function computeAdventStart(year) {
  const nov30 = new Date(year, 10, 30);
  const dayOfWeek = getDay(nov30);
  if (dayOfWeek === 0) return nov30;
  if (dayOfWeek <= 3) return addDays(nov30, -dayOfWeek);
  return addDays(nov30, 7 - dayOfWeek);
}

/** Which church year (Advent-to-Advent) a date falls in. */
function getChurchYear(date) {
  const year = date.getFullYear();
  const advent = computeAdventStart(year);
  if (date >= advent) return { startYear: year, endYear: year + 1 };
  return { startYear: year - 1, endYear: year };
}

/** Lectionary year (A, B, C) for a church year, via yearMap with computed fallback. */
function getLectionaryYear(churchYear) {
  const key = `${churchYear.startYear}/${churchYear.endYear}`;
  const mapped = lectionaryData.yearMap[key];
  if (mapped === "A" || mapped === "B" || mapped === "C") return mapped;
  const mod = (((churchYear.startYear - 2001) % 3) + 3) % 3;
  return ["A", "B", "C"][mod];
}

// ─── Local calendar computation ─────────────────────────────────

/**
 * For "Proper" Sundays (Ordinary Time), find the matching JSON key by date-range.
 * E.g. "Sunday between 26 June and 2 July inclusive" matches 29 June.
 */
function findProperSundayKey(date) {
  const monthNames = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const MONTHS =
    "January|February|March|April|May|June|July|August|September|October|November|December";

  for (const [key, entry] of Object.entries(lectionaryData.sundays)) {
    let sDay, sMonth, eDay, eMonth;
    const cross = entry.name.match(
      new RegExp(`Sunday between (\\d+)\\s+(${MONTHS})\\s+and\\s+(\\d+)\\s+(${MONTHS})`, "i"),
    );
    if (cross) {
      sDay = parseInt(cross[1], 10);
      sMonth = monthNames[cross[2].toLowerCase()];
      eDay = parseInt(cross[3], 10);
      eMonth = monthNames[cross[4].toLowerCase()];
    } else {
      const same = entry.name.match(
        new RegExp(`Sunday between (\\d+)\\s+and\\s+(\\d+)\\s+(${MONTHS})`, "i"),
      );
      if (!same) continue;
      sDay = parseInt(same[1], 10);
      eDay = parseInt(same[2], 10);
      sMonth = eMonth = monthNames[same[3].toLowerCase()];
    }
    if (sMonth === undefined || eMonth === undefined) continue;

    const startDate = new Date(date.getFullYear(), sMonth, sDay);
    const endDate = new Date(date.getFullYear(), eMonth, eDay);
    if (iso(date) >= iso(startDate) && iso(date) <= iso(endDate)) return key;
  }
  return null;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Compute the full liturgical calendar locally (no API). Maps every Sunday and key feast
 * to its lectionary JSON key. Returns [{ date, sundayKey, name, season, colour }].
 */
function computeLiturgicalCalendar(churchYear) {
  const entries = [];
  const year = churchYear.endYear;

  const adventStart = computeAdventStart(churchYear.startYear);
  const nextAdvent = computeAdventStart(churchYear.endYear);
  const easter = computeEasterDate(year);
  const ashWed = addDays(easter, -46);
  const pentecost = addDays(easter, 49);
  const trinitySunday = addDays(easter, 56);
  const christmasDay = new Date(churchYear.startYear, 11, 25);
  const epiphanyDate = new Date(year, 0, 6);

  const addEntry = (date, key, name, season, colour) =>
    entries.push({ date: iso(date), sundayKey: key, name, season, colour });

  let adventNum = 0, christmasNum = 0, epiphanyNum = 0, lentNum = 0, easterNum = 0;

  const allDates = eachDayOfInterval({ start: adventStart, end: addDays(nextAdvent, -1) });
  const sundays = allDates.filter((d) => isSunday(d));

  for (const sunday of sundays) {
    const d = iso(sunday);

    if (d < iso(christmasDay)) {
      adventNum++;
      const ord = ["first", "second", "third", "fourth"];
      if (adventNum <= 4) {
        addEntry(sunday, `the-${ord[adventNum - 1]}-sunday-of-advent`,
          `The ${cap(ord[adventNum - 1])} Sunday of Advent`, "ADVENT", "PURPLE");
      }
      continue;
    }

    if (d >= iso(christmasDay) && d < iso(epiphanyDate)) {
      christmasNum++;
      const ord = ["first", "second"];
      if (christmasNum <= 2) {
        addEntry(sunday, `the-${ord[christmasNum - 1]}-sunday-of-christmas`,
          `The ${cap(ord[christmasNum - 1])} Sunday of Christmas`, "CHRISTMAS", "WHITE");
      }
      continue;
    }

    if (d >= iso(epiphanyDate) && d < iso(ashWed)) {
      const sundayBeforeLent = addDays(ashWed, -(getDay(ashWed) || 7));
      const secondBeforeLent = addDays(sundayBeforeLent, -7);
      if (d === iso(sundayBeforeLent)) {
        addEntry(sunday, "the-sunday-next-before-lent", "The Sunday next before Lent", "ORDINARY", "GREEN");
        continue;
      }
      if (d === iso(secondBeforeLent)) {
        addEntry(sunday, "the-second-sunday-before-lent", "The Second Sunday before Lent", "ORDINARY", "GREEN");
        continue;
      }
      epiphanyNum++;
      if (epiphanyNum === 1) {
        addEntry(sunday, "the-baptism-of-christ", "The Baptism of Christ", "EPIPHANY", "WHITE");
      } else if (epiphanyNum <= 4) {
        const ord = { 2: "second", 3: "third", 4: "fourth" }[epiphanyNum];
        addEntry(sunday, `the-${ord}-sunday-of-epiphany`,
          `The ${cap(ord)} Sunday of Epiphany`, "EPIPHANY", "WHITE");
      } else {
        const properKey = findProperSundayKey(sunday);
        if (properKey) {
          addEntry(sunday, properKey, lectionaryData.sundays[properKey]?.name || properKey, "ORDINARY", "GREEN");
        }
      }
      continue;
    }

    if (d >= iso(ashWed) && d < iso(easter)) {
      lentNum++;
      if (lentNum <= 5) {
        const ord = ["first", "second", "third", "fourth", "fifth"];
        addEntry(sunday, `the-${ord[lentNum - 1]}-sunday-of-lent`,
          `The ${cap(ord[lentNum - 1])} Sunday of Lent`, "LENT", "PURPLE");
      } else {
        addEntry(sunday, "palm-sunday", "Palm Sunday", "HOLY_WEEK", "RED");
      }
      continue;
    }

    if (d >= iso(easter) && d < iso(pentecost)) {
      easterNum++;
      if (easterNum === 1) {
        addEntry(sunday, "easter-day", "Easter Day", "EASTER", "WHITE");
      } else if (easterNum <= 6) {
        const ord = { 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth" }[easterNum];
        addEntry(sunday, `the-${ord}-sunday-of-easter`,
          `The ${cap(ord)} Sunday of Easter`, "EASTER", "WHITE");
      } else {
        addEntry(sunday, "sunday-after-ascension-day", "Sunday after Ascension Day", "EASTER", "WHITE");
      }
      continue;
    }

    if (d === iso(pentecost)) {
      addEntry(sunday, "day-of-pentecost-whit-sunday", "Day of Pentecost (Whit Sunday)", "PENTECOST", "RED");
      continue;
    }

    if (d === iso(trinitySunday)) {
      addEntry(sunday, "trinity-sunday", "Trinity Sunday", "TRINITY", "WHITE");
      continue;
    }

    if (d > iso(trinitySunday) && d < iso(nextAdvent)) {
      const weeksBeforeAdvent = Math.ceil(
        (nextAdvent.getTime() - sunday.getTime()) / (7 * 24 * 60 * 60 * 1000),
      );
      if (weeksBeforeAdvent === 1) {
        addEntry(sunday, "christ-the-king", "Christ the King", "KINGDOM", "WHITE");
      } else if (weeksBeforeAdvent === 2) {
        addEntry(sunday, "the-second-sunday-before-advent", "The Second Sunday before Advent", "ORDINARY", "GREEN");
      } else if (weeksBeforeAdvent === 3) {
        addEntry(sunday, "the-third-sunday-before-advent", "The Third Sunday before Advent", "ORDINARY", "GREEN");
      } else if (weeksBeforeAdvent === 4) {
        addEntry(sunday, "the-fourth-sunday-before-advent", "The Fourth Sunday before Advent", "ORDINARY", "GREEN");
      } else if (weeksBeforeAdvent === 5) {
        addEntry(sunday, "bible-sunday", "Bible Sunday", "ORDINARY", "GREEN");
      } else {
        const properKey = findProperSundayKey(sunday);
        if (properKey) {
          addEntry(sunday, properKey, lectionaryData.sundays[properKey]?.name || properKey, "ORDINARY", "GREEN");
        }
      }
      continue;
    }
  }

  // ─── Fixed feasts (weekday) ───
  const weekdayFeasts = [
    [christmasDay, "christmas-day", "Christmas Day", "CHRISTMAS", "WHITE"],
    [new Date(year, 0, 1), "the-naming-and-circumcision-of-jesus", "The Naming and Circumcision of Jesus", "CHRISTMAS", "WHITE"],
    [epiphanyDate, "the-epiphany", "The Epiphany", "EPIPHANY", "WHITE"],
    [ashWed, "ash-wednesday", "Ash Wednesday", "LENT", "PURPLE"],
    [addDays(easter, -3), "maundy-thursday", "Maundy Thursday", "HOLY_WEEK", "WHITE"],
    [addDays(easter, -2), "good-friday", "Good Friday", "HOLY_WEEK", "RED"],
    [addDays(easter, -1), "easter-eve", "Easter Eve", "EASTER", "WHITE"],
    [addDays(easter, 39), "ascension-day", "Ascension Day", "ASCENSION", "WHITE"],
  ];
  for (const [date, key, name, season, colour] of weekdayFeasts) {
    if (!isSunday(date) && date >= adventStart && date < nextAdvent) {
      addEntry(date, key, name, season, colour);
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries;
}

/** Look up the readings for a sundayKey + lectionary year, principal track. */
function getReadings(sundayKey, lectionaryYear) {
  const sunday = lectionaryData.sundays[sundayKey];
  if (!sunday || !sunday.years[lectionaryYear]) return [];
  return sunday.years[lectionaryYear].principal || [];
}

module.exports = {
  iso,
  computeEasterDate,
  computeAdventStart,
  getChurchYear,
  getLectionaryYear,
  computeLiturgicalCalendar,
  findProperSundayKey,
  getReadings,
  lectionaryData,
};
