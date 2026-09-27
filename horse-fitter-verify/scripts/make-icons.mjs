// Regenerates the PNG app icons from app/icons/icon.svg. Needs Playwright:
//   npx playwright install chromium   (once)   then   node scripts/make-icons.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../app/icons/", import.meta.url));
const svg = readFileSync(dir + "icon.svg", "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();
const jobs = [["icon-180.png", 180, 0], ["icon-192.png", 192, 0], ["icon-512.png", 512, 0], ["maskable-512.png", 512, 0.12]];
for (const [name, size, pad] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  // Maskable icons keep the artwork inside the central safe zone on a full-bleed background.
  await page.setContent(`<body style="margin:0;background:#141A22"><div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">
    <div style="width:${size * (1 - 2 * pad)}px;height:${size * (1 - 2 * pad)}px">${svg.replace("<svg ", '<svg width="100%" height="100%" ')}</div></div></body>`);
  await page.screenshot({ path: dir + name, omitBackground: pad === 0 });
  console.log("wrote", name);
}
await browser.close();
