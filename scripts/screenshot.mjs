// Regenerates docs/screenshot.png from the production build (demo data).
// Usage: npm run build && node scripts/screenshot.mjs
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 4182;
const out = join(import.meta.dirname, '..', 'docs', 'screenshot.png');

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((resolve) => server.stdout.on('data', (d) => String(d).includes(String(PORT)) && resolve()));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.5 });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelectorAll('#replayListContainer > div').length === 3);
  await page.click('#btnSelectAllReplays');
  await page.$eval('#timelineScrubber', (e) => {
    e.value = '4400';
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const height = await page.$eval('main', (e) => Math.ceil(e.getBoundingClientRect().bottom));
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1600, height } });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
  server.kill();
}
