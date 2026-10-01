// Renders icons/icon{16,32,48,128}.png from an inline SVG using Playwright.
// Usage: node scripts/make-icons.mjs
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect x="4" y="4" width="120" height="120" rx="26" fill="#032d42"/>
  <path d="M40 38 L18 64 L40 90" fill="none" stroke="#62d84e" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M88 38 L110 64 L88 90" fill="none" stroke="#62d84e" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M64 34 L70 56 L92 62 L70 68 L64 92 L58 68 L36 62 L58 56 Z" fill="#ffffff"/>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(new URL(`../icons/icon${size}.png`, import.meta.url), buf);
}
await browser.close();
console.log('icons written');
