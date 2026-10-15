// End-to-end smoke test against the production build in headless Chrome, with all external network blocked.
// Usage: npm run build && node scripts/smoke.mjs [--shots]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 4179;
const URL = `http://localhost:${PORT}/`;
const shots = process.argv.includes('--shots');
const fixtures = join(import.meta.dirname, '..', 'tests', 'fixtures');

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && resolve());
  server.on('exit', (c) => reject(new Error(`preview exited ${c}`)));
  setTimeout(() => reject(new Error('preview timeout')), 20000);
});

const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1300, deviceScaleFactor: 2 });
  const errors = [];
  const external = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (r.url().startsWith(URL) || r.url().startsWith('blob:') || r.url().startsWith('data:')) r.continue();
    else {
      external.push(r.url());
      r.abort();
    }
  });

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelectorAll('#replayListContainer > div').length === 3, { timeout: 10000 });
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const text = async (sel) => { await settle(); return page.$eval(sel, (e) => e.textContent.trim()); };

  check((await text('#beatmapCountBadge')) === '2 张谱面', 'demo: 2 beatmaps');
  check((await text('#selectedReplayCountBadge')) === '已选 2 / 3 个', 'demo: 2 of 3 replays selected');
  check((await text('#currentScopeBadge')).includes('2s 时间片 #3'), `demo: scope is slice #3 (${await text('#currentScopeBadge')})`);
  check((await text('#timeCurrentLabel')) === '00:04.100', 'demo: time 4.100');
  check(Number(await text('#statSliceMissCount')) > 0, 'demo: slice #3 has misses');
  check((await page.$$('#timeSliceStrip > button')).length === 7, 'demo: 7 slices of 2s');
  const fontOk = await page.evaluate(() => document.fonts.check('12px Inter') && document.fonts.check('12px "JetBrains Mono"'));
  check(fontOk, 'fonts are bundled and loaded offline');
  const bg = await page.$eval('header', (e) => getComputedStyle(e).position);
  check(bg === 'sticky', 'tailwind styles applied (header is sticky)');
  if (shots) await page.screenshot({ path: '/tmp/osu-smoke-1.png', fullPage: true });

  // The 4:3 playfield must never grow over the key HUD column, even when that column is tall.
  await page.click('#btnSelectAllReplays');
  for (const width of [1600, 1250]) {
    await page.setViewport({ width, height: 1300, deviceScaleFactor: 2 });
    await settle();
    const overlap = await page.evaluate(() => {
      const box = document.getElementById('osuPlayfieldCanvas').parentElement.getBoundingClientRect();
      const hud = document.getElementById('osuPlayfieldCanvas').parentElement.nextElementSibling.getBoundingClientRect();
      return box.right > hud.left + 1 && box.top < hud.bottom - 1 && hud.top < box.bottom - 1;
    });
    check(!overlap, `playfield does not overlap the key HUD at ${width}px`);
  }
  await page.setViewport({ width: 1600, height: 1300, deviceScaleFactor: 2 });
  await page.$eval('#replayListContainer > div:nth-child(3) input[type=checkbox]', (e) => e.click());

  // Frame stepping lands on real primary frames.
  await page.click('#btnStepForward1F');
  const t1 = await text('#timeCurrentLabel');
  await page.click('#btnStepForward1F');
  const t2 = await text('#timeCurrentLabel');
  check(t1 !== '00:04.100' && t2 !== t1, `step +1 frame moves time (${t1} → ${t2})`);

  // Playback advances and pauses.
  await page.click('#btnPlayPause');
  await new Promise((r) => setTimeout(r, 600));
  await page.click('#btnPlayPause');
  check((await text('#playPauseText')) === '播放', 'play/pause toggles');

  // Jump to next miss.
  await page.click('#btnStepNextMiss');
  check((await text('#hudNearestJudgment')).startsWith('MISS'), `next miss shows a MISS judgement (${await text('#hudNearestJudgment')})`);

  // Tabs render charts without errors.
  for (const tab of ['tap', 'trend', 'aim']) {
    await page.click(`.detail-tab-btn[data-tab="${tab}"]`);
    await new Promise((r) => setTimeout(r, 120));
  }
  check(!(await page.$eval('#tabPanelAim', (e) => e.classList.contains('hidden'))), 'tabs switch');

  // Slice length change relabels everything.
  await page.select('#sliceDurationSelect', '5000');
  await new Promise((r) => setTimeout(r, 100));
  check((await text('#currentScopeBadge')).includes('5s 时间片 #1'), `5s slice label (${await text('#currentScopeBadge')})`);
  check((await page.$$('#timeSliceStrip > button')).length === 3, '3 slices of 5s');

  // Range selection with pointer drag, crossing the anchor.
  await page.click('#btnToggleRangeSelect');
  await settle();
  const box = await page.$eval('#timelineTrackWrapper', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + box.w * 0.5, box.y + box.h / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.7, box.y + box.h / 2, { steps: 5 });
  await page.mouse.up();
  await settle();
  const custom = await text('#currentScopeBadge');
  check(custom.startsWith('当前分析：自定义区间'), `sweep creates a custom range (${custom})`);
  await settle();
  const handle = await page.$eval('#rangeHandleStart', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.9, handle.y, { steps: 6 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 100));
  const crossed = await text('#scrubberSelectedRangeBadge');
  const m = /([\d.]+)s - ([\d.]+)s/.exec(crossed);
  const dur = 13.2;
  check(m && Math.abs(Number(m[1]) - dur * 0.7) < 0.3 && Math.abs(Number(m[2]) - dur * 0.9) < 0.3, `dragging start handle past the end keeps the old end as anchor (${crossed})`);
  await page.click('#btnToggleRangeSelect');

  // Import through the modal input: map + replays (incl. truncated and taiko).
  const input = await page.$('#manualFileInput');
  await input.uploadFile(...['fixture_map.osu', 'replay_nm.osr', 'replay_hr.osr', 'replay_truncated.osr', 'replay_taiko.osr'].map((f) => join(fixtures, f)));
  await page.waitForFunction(() => document.querySelector('#beatmapCountBadge').textContent === '3 张谱面', { timeout: 10000 });
  check((await text('#selectedReplayCountBadge')) === '已选 2 / 2 个', 'import: switched to new map with 2 new replays');
  check((await text('#currentScopeBadge')) === '当前分析：全图概览', 'import: scope reset to full map');
  check((await text('#timeCurrentLabel')) === '00:00.000', 'import: time reset to 0');
  check((await text('#importResultsSummary')).includes('解析失败 1') && (await text('#importResultsSummary')).includes('非 std 1'), `import results list failures (${await text('#importResultsSummary')})`);
  check(!(await page.$eval('#btnClearDemo', (e) => e.classList.contains('hidden'))), '“clear demo” offered after real import');

  // Same file can be picked again (input value is reset) → reported as duplicate.
  await input.uploadFile(join(fixtures, 'replay_nm.osr'));
  await page.waitForFunction(() => document.querySelector('#importResultsSummary').textContent.includes('重复跳过 1'), { timeout: 5000 }).catch(() => {});
  check((await text('#importResultsSummary')).includes('重复跳过 1'), 're-selecting the same file triggers an import (duplicate)');

  // Page-wide drop with an XSS title and an orphan replay.
  await page.evaluate(async (orphanBytes) => {
    const dt = new DataTransfer();
    const evil = 'osu file format v14\n[Metadata]\nTitle:<img src=x onerror="window.__xss=1">\nArtist:<b>bold</b>\nVersion:V\nBeatmapID:0\n[Difficulty]\nCircleSize:4\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n100,100,1000,1,0\n';
    dt.items.add(new File([evil], 'evil.osu'));
    dt.items.add(new File([new Uint8Array(orphanBytes)], 'orphan.osr'));
    for (const type of ['dragenter', 'dragover', 'drop']) {
      document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
  }, [...readFileSync(join(fixtures, 'replay_missing_map.osr'))]);
  await page.waitForFunction(() => document.querySelector('#beatmapCountBadge').textContent === '4 张谱面', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 300));
  check(await page.evaluate(() => window.__xss === undefined && !document.querySelector('img[src="x"]')), 'XSS title is rendered as text [B8]');
  check((await page.$eval('#beatmapGroupList', (e) => e.textContent)).includes('<img src=x'), 'malicious title visible as plain text');
  check(!(await page.$eval('#pendingSection', (e) => e.classList.contains('hidden'))), 'orphan replay shown in pending list [B2]');
  check(!(await page.$eval('#dropOverlay', (e) => e.classList.contains('hidden'))) === false, 'drop overlay hidden after drop');

  // Simulate a new play on the demo map.
  await page.click('#beatmapGroupList > button:nth-last-child(2)');
  await page.click('#btnSimulateLiveScore');
  await page.waitForFunction(() => document.querySelectorAll('#replayListContainer > div').length === 4, { timeout: 10000 });
  check(true, 'simulate new play adds a replay');

  await page.click('#btnClearDemo');
  await new Promise((r) => setTimeout(r, 200));
  check((await text('#beatmapCountBadge')) === '2 张谱面', `clear demo leaves imported maps (${await text('#beatmapCountBadge')})`);
  if (shots) await page.screenshot({ path: '/tmp/osu-smoke-2.png', fullPage: true });

  check(errors.length === 0, `no console/page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  check(external.length === 0, `no external network requests${external.length ? ': ' + external.join(', ') : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall smoke checks passed');
