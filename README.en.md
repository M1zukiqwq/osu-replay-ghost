<div align="center">

# osu-replay-ghost

**Analyze osu! stable replays in your browser: find misses by time slice, overlay ghost trails from multiple replays, and step through K1/K2 input frame by frame**

[简体中文](README.md) | English

![License](https://img.shields.io/badge/license-MIT-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)
![Vite](https://img.shields.io/badge/Vite-8-646cff)
![Offline](https://img.shields.io/badge/works%20offline-✓-34d399)

</div>

![Screenshot](docs/screenshot.png)

> The interface is currently in Chinese only.

## What is it

You just played a map. Which seconds did you break combo in? Did you overaim or underaim? Could your single-tapping keep up? This tool loads osu! stable `.osr` replays and `.osu` beatmaps into the browser. It cuts the map into time slices and counts misses in each one, then plays the replay back frame by frame on a 512×384 playfield. Overlay your latest attempt with your personal best and you can see exactly where the two cursor paths split.

Everything is parsed and computed locally in your browser. **No files are uploaded**, and the production build works fully offline.

## Features

- **Beatmap browser with on-demand replay loading** (beatmap info and replay preview are fully separate)
  - Bind your osu! folder and the tool reads `osu!.db` and lists the file names in `Data/r/` once. Those names are `<beatmap MD5>-<timestamp>`, so the "recently played" list needs no replay to be opened.
  - "Search" takes a Beatmap ID, a beatmapset ID, an osu! link (`/b/`, `/beatmapsets/…#osu/…`, `b:123`, `s:123`), an MD5, or keywords matched against title, artist, mapper, difficulty name and tags.
  - Only when you pick a beatmap is its `.osu` read from `Songs/`, followed by its local replays from `Data/r/` and `Replays/` (newest 30 first; older ones load on request). `Replays/` names carry no MD5, so the first time, the first 128 bytes of each file are read to match it; after that only new files are read.
  - After a play, that beatmap moves to the top of "recently played" with a "new" badge. If it is the beatmap you are previewing, the new replay is added straight away and becomes the primary.
  - New plays are picked up from `FileSystemObserver` change events (Chrome / Edge 133+), so folders are not scanned while idle. Browsers without it fall back to listing file names on a timer: the interval backs off from 3 to 15 seconds while nothing changes, pauses while the page is hidden, and checks immediately when you come back.
  - osu! only writes `osu!.db` when the game exits, so maps downloaded during the current session may be missing from it. Opening such a map hashes only the `Songs/` folders that `osu!.db` doesn't list.
  - Only the last few beatmaps opened from the browser stay in memory; older ones are released together with their replays.
  - You can also pick files manually, or drop `.osr` / `.osu` / `osu!.db` anywhere on the page.
- **Grouping by beatmap**: replays are grouped by beatmap MD5, and different versions of the same BeatmapID are listed separately. Replays whose beatmap isn't loaded yet wait in a "pending" list and attach themselves once you import the matching `.osu`.
- **Time-slice diagnosis**
  - Slices of 1 / 2 / 3 / 5 seconds; bar colours show misses, slider breaks, 100s/50s, or a clean full combo.
  - One click jumps to the slice with the most misses (slider breaks break ties).
  - You can also drag-select any range on the progress bar (works on touch screens).
  - Below the main progress bar, a detail bar shows only the current range (plus 10%, at least 100 ms, on each side) with the primary replay's misses, slider breaks and 100/50s marked; hover a mark to see why. Click to seek; drag to select a sub-range and zoom into it, level by level, and step back out with 「返回上一区间」 (back to previous range); drag the handles to fine-tune the edges.
- **Ghost playback**
  - Cursor trails from several replays are overlaid, with K1/K2 press markers and lines from each circle centre to where you actually hit.
  - At a slider break the follow circle is drawn, with the dropped tick / repeat / tail, where the cursor was, and why (key released, outside the follow circle, not picked up again).
  - Step through the replay's real frames, jump to the previous/next miss or slider break, play at 0.1x–1.0x, with synthesised hitsounds.
- **Range analytics**
  - K1/K2 counts and ratio, KPS, UR, alternation rate, mean offset.
  - Overaim / underaim radar.
  - Hit-error histogram and key hold times.
  - Cursor speed curves (all replays aligned on one time axis) and tap intervals.
- **Mods**: HR / EZ adjust CS, AR and OD. HR replays are flipped back into beatmap coordinates, so replays with different mods can still be overlaid.
- **Demo mode**: 2 demo beatmaps and 5 synthetic replays are built in, so the page is useful the moment you open it. All demo data is labelled "演示" (demo) and can be removed with one click once you import real data.

## Quick start

Requires Node.js 20.19+ or 22.12+.

```bash
git clone https://github.com/M1zukiqwq/osu-replay-ghost.git
cd osu-replay-ghost
npm install
npm run dev
```

Open <http://localhost:5173> in your browser.

To build a static version that works offline:

```bash
npm run build      # output in dist/
npm run preview    # preview dist/ locally
```

`dist/` is plain static files and can be hosted anywhere. Folder binding needs HTTPS when hosted.

## Usage

### Option 1: Bind your osu! folder (recommended)

1. Open the page in **Chrome or Edge**. Folder binding relies on the File System Access API.
2. Click 「绑定本地 osu! 根目录」 (bind osu! folder) in the header and select your osu! stable install folder:
   - Windows default: `%LOCALAPPDATA%\osu!`
   - macOS (Wine wrapper): `/Applications/osu!.app/Contents/Resources/drive_c/Program Files/osu!/`. Press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>G</kbd> in the picker to type the path.
3. Once bound, the beatmap browser on the left switches to 「最近游玩」 (recently played). Click a beatmap and only then are its local replays read; you can also find beatmaps by ID or keyword under 「搜索」 (search).
4. After every play, that beatmap moves to the top of the recent list. If you are looking at that beatmap, the new replay is added right away.
5. If your osu! config puts Songs outside the osu! folder, an "authorise Songs" button appears. If there's no `osu!.db`, you can click 「扫描 Songs」 (scan Songs) to match beatmaps by hashing every `.osu`. This is slower and runs in a background thread.

After a page reload, click 「恢复绑定」 (restore binding) and grant access again. You don't have to pick the folder again.

### Option 2: Manual import

Click 「手动导入 .osr / .osu」 (manual import), or drop files onto the page. Replays find their beatmap by MD5. When the import finishes, a summary notification appears; click 「查看明细」 (details) to see the result and any error for each file.

### Analyzing a play

1. Choose a beatmap on the left, tick the replays to compare, and click ★ to pick the primary replay. Hitsounds, miss / slider-break jumping and UR follow the primary replay. A freshly opened beatmap starts with the latest play and the most accurate play selected.
2. Click the slice with the most misses, or 「⚡ 定位最高 Miss 时间片」 (jump to worst slice).
3. <kbd>Space</kbd> plays/pauses, <kbd>←</kbd> / <kbd>→</kbd> step one frame, <kbd>Shift</kbd> + arrow steps 10 frames.
4. Use the Aim / Keys / Speed tabs on the right to see statistics for the current range.

## How the numbers are computed

- **Settled results and simulated judgements are kept apart.**
  - The 300 / 100 / Miss counts on replay and beatmap cards come from the `.osr` header, i.e. the game's own results, and are labelled 「结算」 (settled).
  - Misses, offsets and hit errors in the slice chart and analytics panel come from this tool re-judging the cursor data. They are labelled 「模拟」 (simulated) and may differ from the settled results.
- **The simulated judgement is an approximation**:
  - It judges circles and slider heads, with notelock. Clicks outside the circle are ignored, so you can re-tap. A press up to 400 ms early counts as a miss.
  - Sliders follow stable's rules:
    - Any head hit inside the 50 window counts.
    - The body is judged with the follow circle: once the slider starts, holding a key with the cursor inside the circle radius picks up the ball, and tracking continues while a key stays held and the cursor stays within 2.4× the radius.
    - Ticks and repeats are placed the way osu! generates them; for maps older than v8, SV is ignored in the tick spacing. The tail is checked 36 ms before the end (but never before the slider's midpoint).
    - The result is the share of parts hit: all = 300, at least half = 100, any = 50, none = miss.
  - **Slider break**: the head, a tick or a repeat was dropped (the tail doesn't count), but the slider as a whole is not a miss. Slider breaks are counted separately and never added to misses, matching how the game counts misses.
  - Spinners are excluded from aim and timing.
  - Stacking offsets are not modelled yet.
- **Anything that can't be computed is shown as "—"** rather than a default value. For example, UR shows "—" when a range has fewer than 2 hits.
- Every range statistic uses half-open intervals `[start, end)`, so an object on a slice boundary is counted in exactly one slice.

## Development

```bash
npm test             # unit tests (Vitest)
npm run typecheck    # type check
npm run smoke        # build + end-to-end checks in headless Chrome (external network blocked)
npm run perf         # frame rate and drag responsiveness on a 5-minute / 1500-object map
npm run fixtures     # regenerate test fixtures (needs python3)
npm run screenshot   # regenerate docs/screenshot.png
```

`smoke`, `perf` and `screenshot` default to Chrome's macOS location; set `CHROME_PATH` to point at a browser on other systems.

### Project layout

```
src/
  core/        pure logic, no DOM, testable in Node
    binary/      bounds-checked binary reader/writer, MD5
    lzma/        LZMA decoder/encoder (no dependencies)
    formats/     .osr / .osu / osu!.db parsing and writing
    beatmap/     timing (red/green lines), slider paths (L / P / B / C), mod difficulty
    replay/      frame decoding, HR flip, key press events
    analysis/    judgement, aim decomposition, metrics, time slices, speed resampling
    demo/        seeded PRNG, synthetic replays, demo beatmaps
  worker/      Web Worker: LZMA decompression, osu!.db parsing, judgement
  app/         state and actions, import pipeline, beatmap library, folder watcher (file names only), beatmap browser, replay preview
  ui/          rendering (canvas, charts, panels)
scripts/       fixture generation, end-to-end checks, perf checks, screenshots
tests/         unit tests and fixtures (all fixtures are generated by scripts)
```

### Technical notes

- Stack: TypeScript, Vite, Tailwind CSS, Chart.js. Fonts and the chart library are bundled; nothing is loaded from a CDN at runtime.
- All external text (beatmap titles, player names, file names, …) is rendered as plain text. The code never uses `innerHTML`, and a test enforces this.
- Slider paths follow osu-framework's `PathApproximator`. Catmull sliders use the same uniform Catmull-Rom as the game.
- LZMA decoding stops at the size declared in the `.osr`, matching the 7-Zip SDK the game uses.
- Decompression, parsing and judgement run in a Web Worker, and lookups in the render loop use binary search. A 5-minute, 1500-object map with 5 replays overlaid plays at 60 fps.

## Known limitations

- Only osu!standard and osu! stable local replays are supported. Taiko / catch / mania replays are skipped with a reason.
- Judgement is an approximation (see above) and may not match the game exactly.
- Folder binding needs the File System Access API, which only Chromium-based browsers (Chrome, Edge, …) support today; live change events also need `FileSystemObserver` (version 133+), and older versions fall back to timed checks. Other browsers can only read a one-off snapshot through a folder picker.
- The timestamp in `Data/r/` names is read as either a Windows FILETIME or .NET ticks, whichever gives a plausible year. It is only used to sort the recent list.
- These have only been tested with synthetic data so far; feedback from real setups is welcome:
  - the full flow after binding a real stable install
  - the coordinate flip for HR replays
  - range dragging on touch devices

## License and disclaimer

Released under the [MIT License](LICENSE).

osu! is a trademark of ppy Pty Ltd. This is a community project and is not affiliated with or endorsed by ppy.
