// Performance check (B30): 5-minute map with 1500 objects and several replays.
// Usage: npm run build && node scripts/perf.mjs
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 4180;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((resolve) => server.stdout.on('data', (d) => String(d).includes(String(PORT)) && resolve()));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
let failed = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 2 });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelectorAll('#replayListContainer > div').length === 3);

  await page.evaluate(() => {
    const lines = ['osu file format v14', '[Metadata]', 'Title:Perf Map', 'Artist:Bench', 'Version:Long', 'BeatmapID:0',
      '[Difficulty]', 'CircleSize:4', 'OverallDifficulty:8', 'ApproachRate:9', 'SliderMultiplier:1.6',
      '[TimingPoints]', '0,300,4,1,0,100,1,0', '[HitObjects]'];
    let t = 1000;
    for (let i = 0; i < 1500; i++) {
      const x = 64 + ((i * 97) % 384);
      const y = 48 + ((i * 53) % 288);
      if (i % 6 === 5) {
        lines.push(`${x},${y},${t},${i % 24 === 5 ? 6 : 2},0,B|${x + 60}:${y + 40}|${x + 120}:${y},2,120`);
        t += 600;
      } else {
        lines.push(`${x},${y},${t},${i % 8 === 0 ? 5 : 1},0`);
        t += 150;
      }
    }
    const dt = new DataTransfer();
    dt.items.add(new File([lines.join('\n')], 'perf.osu'));
    for (const type of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.waitForFunction(() => document.querySelector('#beatmapCountBadge').textContent === '3 张谱面');

  const simStart = Date.now();
  for (let i = 0; i < 4; i++) {
    await page.click('#btnSimulateLiveScore');
    await page.waitForFunction((n) => document.querySelectorAll('#replayListContainer > div').length === n, { timeout: 30000 }, i + 1);
  }
  console.log(`synthesised 4 replays in ${Date.now() - simStart} ms (worker)`);
  await page.click('#btnSelectAllReplays');
  await page.click('#btnResetFullMapScope');
  const duration = await page.$eval('#timeTotalLabel', (e) => e.textContent);
  console.log(`map duration ${duration}`);

  // Warm-up: the first Play creates the AudioContext (one-time, ~150 ms in headless Chrome).
  await page.click('#btnPlayPause');
  await page.click('#btnPlayPause');
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((l) => window.__long.push(...l.getEntries().map((e) => e.duration))).observe({ type: 'longtask', buffered: false });
  });

  // Playback at 1.0x for 3 s.
  await page.click('.speed-btn[data-speed="1"]');
  await page.$eval('#timelineScrubber', (e) => { e.value = '120000'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#btnPlayPause');
  const fps = await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const start = performance.now();
    const tick = () => {
      frames++;
      if (performance.now() - start < 3000) requestAnimationFrame(tick);
      else resolve((frames * 1000) / (performance.now() - start));
    };
    requestAnimationFrame(tick);
  }));
  await page.click('#btnPlayPause');
  const playLong = await page.evaluate(() => window.__long.splice(0));
  console.log(`playback: ${fps.toFixed(1)} fps, long tasks: ${playLong.length} (max ${Math.max(0, ...playLong).toFixed(0)} ms)`);
  if (fps < 50 || playLong.some((d) => d > 100)) failed = true;

  // Drag a custom range across the bar for ~1 s.
  await page.click('#btnToggleRangeSelect');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const box = await page.$eval('#timelineTrackWrapper', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, w: r.width }; });
  const t0 = Date.now();
  await page.mouse.move(box.x + box.w * 0.1, box.y);
  await page.mouse.down();
  for (let i = 0; i <= 60; i++) {
    await page.mouse.move(box.x + box.w * (0.1 + 0.8 * (i / 60)), box.y);
    await new Promise((r) => setTimeout(r, 16));
  }
  await page.mouse.up();
  const dragLong = await page.evaluate(() => window.__long.splice(0));
  console.log(`range drag: ${Date.now() - t0} ms for 60 moves, long tasks: ${dragLong.length} (max ${Math.max(0, ...dragLong).toFixed(0)} ms)`);
  if (dragLong.some((d) => d > 100)) failed = true;
  for (const tab of ['tap', 'trend']) {
    await page.click(`.detail-tab-btn[data-tab="${tab}"]`);
    await page.mouse.move(box.x + box.w * 0.3, box.y);
    await page.mouse.down();
    for (let i = 0; i <= 30; i++) {
      await page.mouse.move(box.x + box.w * (0.3 + 0.6 * (i / 30)), box.y);
      await new Promise((r) => setTimeout(r, 16));
    }
    await page.mouse.up();
    const l = await page.evaluate(() => window.__long.splice(0));
    console.log(`range drag on ${tab} tab: long tasks ${l.length} (max ${Math.max(0, ...l).toFixed(0)} ms)`);
    if (l.some((d) => d > 100)) failed = true;
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? 'PERF CHECK FAILED' : 'perf ok');
process.exit(failed ? 1 : 0);
