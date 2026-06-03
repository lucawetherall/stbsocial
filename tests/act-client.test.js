const { test } = require("node:test");
const assert = require("node:assert");
const { genericSacredArt, isOutOfCopyright } = require("../src/act-client.js");

test("isOutOfCopyright accepts only public-domain / CC0 licences", () => {
  // Out of copyright — accepted.
  for (const ok of [
    "Public domain",
    "public domain",
    "Public Domain Mark",
    "PD-Art",
    "PD-old-100",
    "PD-Mark",
    "CC0",
    "CC0 1.0",
    "CC0 1.0 Universal (CC0 1.0) Public Domain Dedication",
    "CC-Zero",
  ]) {
    assert.strictEqual(isOutOfCopyright(ok), true, `should accept: ${ok}`);
  }

  // Still under copyright (even if freely licensed), or unknown — rejected.
  for (const bad of [
    "CC BY 4.0",
    "CC BY-SA 4.0",
    "CC BY-SA 3.0",
    "CC BY 2.0",
    "CC-BY-SA-2.5",
    "CC BY-NC 4.0",
    "CC BY-ND 4.0",
    "GFDL",
    "GNU Free Documentation License",
    "Free Art License",
    "FAL",
    "All rights reserved",
    "Fair use",
    "see source",
    "",
    null,
    undefined,
  ]) {
    assert.strictEqual(isOutOfCopyright(bad), false, `should reject: ${bad}`);
  }

  // Mixed/ambiguous: a PD wording that also carries a CC-BY clause must be rejected.
  assert.strictEqual(
    isOutOfCopyright("Public domain in the US; CC BY-SA 4.0 elsewhere"),
    false,
    "a mixed PD + CC BY-SA string must be rejected",
  );
});

// A fake commonsSearch: returns a deterministic candidate per query so we can test the
// backstop's pooling/dedup/rotation WITHOUT touching the network.
function fakeSearch(results) {
  return async (q) => results[q] || [];
}

test("genericSacredArt returns attributed candidates tagged source=generic", async () => {
  const search = fakeSearch({
    "Christ Pantocrator icon": [
      { source: "commons", title: "Pantocrator", fullUrl: "https://x/a.jpg",
        artworkKey: "a|pantocrator", attribution: '"Pantocrator". Source: Wikimedia Commons.',
        width: 2000, height: 2000, mime: "image/jpeg" },
    ],
  });
  const out = await genericSacredArt({ serviceKey: "2026-06-07" }, { search });
  assert.ok(out.length >= 1, "should return at least one candidate");
  assert.strictEqual(out[0].source, "generic");
  assert.ok(out[0].attribution.length > 0, "must carry an attribution");
});

test("genericSacredArt dedupes by artworkKey across queries", async () => {
  const dup = { source: "commons", title: "Pantocrator", fullUrl: "https://x/a.jpg",
    artworkKey: "a|pantocrator", attribution: "x", width: 2000, height: 2000, mime: "image/jpeg" };
  const search = fakeSearch({ "Christ Pantocrator icon": [dup], "Madonna and Child painting": [dup] });
  const out = await genericSacredArt({ serviceKey: "k" }, { search });
  assert.strictEqual(out.length, 1, "same artwork must not appear twice");
});

test("genericSacredArt rotation varies the first query by serviceKey", async () => {
  // Record which query is asked first for two different serviceKeys.
  const firstAsked = {};
  const mk = (key) => {
    let seen = false;
    return async (q) => { if (!seen) { firstAsked[key] = q; seen = true; } return []; };
  };
  await genericSacredArt({ serviceKey: "2026-06-07" }, { search: mk("a") });
  await genericSacredArt({ serviceKey: "2026-12-25" }, { search: mk("b") });
  // Not a hard guarantee of difference for all inputs, but these two keys must differ.
  assert.notStrictEqual(firstAsked.a, firstAsked.b);
});
