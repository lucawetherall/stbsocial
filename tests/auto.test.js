const { test } = require("node:test");
const assert = require("node:assert");
const { runAuto } = require("../index.js");

test("runAuto runs parse, then images, then build, with the same services file", async () => {
  const calls = [];
  const spy = (name) => async (file) => { calls.push([name, file]); };
  await runAuto({ parse: spy("parse"), images: spy("images"), build: spy("build"), servicesFile: "/tmp/s.json" });
  assert.deepStrictEqual(calls, [
    ["parse", "/tmp/s.json"],
    ["images", "/tmp/s.json"],
    ["build", "/tmp/s.json"],
  ]);
});
