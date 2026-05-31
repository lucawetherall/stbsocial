const { test } = require("node:test");
const assert = require("node:assert");
const cw = require("../src/cw-calendar.js");

// 2026: Easter is 5 April, so Trinity Sunday is 31 May and the Sundays after Trinity
// follow weekly. These dates are used to pin the "Nth Sunday after Trinity" naming.

test("nthSundayAfterTrinity names actual Sundays in the window", () => {
  assert.strictEqual(cw.nthSundayAfterTrinity("2026-06-07"), "The First Sunday after Trinity");
  assert.strictEqual(cw.nthSundayAfterTrinity("2026-06-14"), "The Second Sunday after Trinity");
});

test("nthSundayAfterTrinity returns null for a weekday (a Thursday is never a Sunday)", () => {
  // 2026-06-11 is a Thursday: it must NOT be labelled a "Sunday after Trinity".
  assert.strictEqual(cw.nthSundayAfterTrinity("2026-06-11"), null);
  assert.strictEqual(cw.nthSundayAfterTrinity("2026-06-25"), null);
});

test("nthSundayAfterTrinity returns null before Trinity Sunday", () => {
  assert.strictEqual(cw.nthSundayAfterTrinity("2026-05-31"), null); // Trinity Sunday itself
});

test("liturgicalInfo gives no Sunday name to a weekday date", () => {
  assert.strictEqual(cw.liturgicalInfo("2026-06-11").liturgicalDayName, null);
  assert.strictEqual(cw.liturgicalInfo("2026-06-14").liturgicalDayName, "The Second Sunday after Trinity");
});
