/**
 * render.js — Puppeteer HTML → PNG, with strict font verification.
 *
 * The reliable fonts-in-screenshots recipe (per the brief):
 *  - setContent(html, { waitUntil: 'networkidle0' })
 *  - await document.fonts.ready
 *  - VERIFY the faces actually loaded (fonts.ready resolves even on silent fallback):
 *    check the display face, the body face, and the body italic face; fail loudly otherwise.
 *  - run the template's __fit() (after fonts are real) so type fits
 *  - screenshot at viewport 1080×1350, deviceScaleFactor 2 → assert 2160×2700.
 */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const POSTER = { width: 1080, height: 1350, scale: 2 };

let _browser = null;
async function getBrowser() {
  if (!_browser) {
    _browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--force-color-profile=srgb"],
    });
  }
  return _browser;
}
async function closeBrowser() {
  if (_browser) { await _browser.close(); _browser = null; }
}

/**
 * Render an HTML string to a PNG file. Returns { width, height, fit }.
 * Throws if a required font face did not load or the dimensions are wrong.
 */
async function renderHtmlToPng(html, outPath) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: POSTER.width, height: POSTER.height, deviceScaleFactor: POSTER.scale,
    });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 60000 });
    await page.evaluate(async () => { await document.fonts.ready; });

    // Verify the actual faces loaded — guards against silent system-serif fallback.
    const fontCheck = await page.evaluate(() => ({
      display: document.fonts.check('600 64px "Cormorant Garamond"'),
      displayItalic: document.fonts.check('italic 500 28px "Cormorant Garamond"'),
      body: document.fonts.check('400 29px "Source Serif 4"'),
      bodyItalic: document.fonts.check('italic 400 29px "Source Serif 4"'),
    }));
    const missing = Object.entries(fontCheck).filter(([, ok]) => !ok).map(([k]) => k);
    if (missing.length) {
      throw new Error(
        `Font faces failed to load (would render with a wrong fallback serif): ${missing.join(", ")}. `
        + "Check assets/fonts and the @font-face embedding in compose.js.",
      );
    }

    const fit = await page.evaluate(() => (window.__fit ? window.__fit() : null));

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, type: "png", clip: { x: 0, y: 0, width: POSTER.width, height: POSTER.height } });

    // Assert exact output dimensions (1080×1350 @2 = 2160×2700).
    const sharp = require("sharp");
    const meta = await sharp(outPath).metadata();
    const expW = POSTER.width * POSTER.scale, expH = POSTER.height * POSTER.scale;
    if (meta.width !== expW || meta.height !== expH) {
      throw new Error(`Rendered PNG is ${meta.width}×${meta.height}, expected ${expW}×${expH}.`);
    }
    return { width: meta.width, height: meta.height, fit };
  } finally {
    await page.close();
  }
}

module.exports = { renderHtmlToPng, getBrowser, closeBrowser, POSTER };
