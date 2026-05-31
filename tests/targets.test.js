const { test } = require("node:test");
const assert = require("node:assert");
const { buildTargets } = require("../src/targets.js");

// Minimal parsed-date objects (the shape parse-musiclist.js produces). buildTargets only
// reads date / dateDisplay / occasion / feasts / services, so we supply just those.
function dateObj({ date, occasion, feasts = [], services = [] }) {
  return {
    serviceKey: date,
    date,
    dateDisplay: date,
    occasion,
    feasts,
    services,
  };
}

test("a weekday feast yields a SINGLE feast poster (no bogus ordinary-Sunday variant)", () => {
  // 2026-06-11 is a Thursday — St Barnabas. There is no competing ordinary Sunday.
  const targets = buildTargets(dateObj({
    date: "2026-06-11",
    occasion: "St Barnabas the Apostle",
    feasts: ["St Barnabas the Apostle"],
  }));
  assert.strictEqual(targets.length, 1);
  assert.strictEqual(targets[0].variant, "single");
  assert.strictEqual(targets[0].occasion, "St Barnabas the Apostle");
  assert.strictEqual(targets[0].isFeast, true);
  // The single feast poster keeps the bare date key (no -feast/-liturgical suffix).
  assert.strictEqual(targets[0].serviceKey, "2026-06-11");
});

test("a feast on a Sunday yields TWO variants: feast + ordinary liturgical day", () => {
  // 2026-06-14 is a Sunday — a Patronal Festival kept that day competes with the Sunday.
  const targets = buildTargets(dateObj({
    date: "2026-06-14",
    occasion: "The Patronal Festival",
    feasts: ["The Patronal Festival"],
  }));
  assert.strictEqual(targets.length, 2);
  const byVariant = Object.fromEntries(targets.map((t) => [t.variant, t]));
  assert.strictEqual(byVariant.feast.occasion, "The Patronal Festival");
  assert.strictEqual(byVariant.feast.isFeast, true);
  assert.strictEqual(byVariant.liturgical.occasion, "The Second Sunday after Trinity");
  assert.strictEqual(byVariant.liturgical.isFeast, false);
});

test("an ordinary Sunday (no distinct feast) yields a single poster", () => {
  const targets = buildTargets(dateObj({
    date: "2026-06-07",
    occasion: "Trinity Sunday",
    feasts: ["Trinity Sunday"],
  }));
  assert.strictEqual(targets.length, 1);
  assert.strictEqual(targets[0].variant, "single");
  assert.strictEqual(targets[0].occasion, "Trinity Sunday");
});
