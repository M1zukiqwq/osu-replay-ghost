#!/usr/bin/env python3
"""Generates binary test fixtures (.osr / osu!.db) independently of the TypeScript writers.

LZMA data is produced by Python's stdlib (liblzma), so the TS decoder is validated against a real encoder.
Run: python3 scripts/make_fixtures.py
"""
import hashlib
import lzma
import os
import random
import struct

OUT = os.path.join(os.path.dirname(__file__), '..', 'tests', 'fixtures')
TICKS_AT_EPOCH = 621355968000000000
PLAYED_AT_MS = 1704164645000  # 2024-01-02T03:04:05Z


def uleb(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def ostr(s):
    if s is None:
        return b'\x00'
    data = s.encode('utf-8')
    return b'\x0b' + uleb(len(data)) + data


MAP = """osu file format v14

[General]
Mode: 0
StackLeniency: 0.7

[Metadata]
Title:Fixture Map
TitleUnicode:Fixture Map
Artist:Fixture
ArtistUnicode:Fixture
Creator:tests
Version:Judgement
BeatmapID:0
BeatmapSetID:-1

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,1,0,100,1,0

[HitObjects]
100,100,1000,5,0,0:0:0:0:
300,100,1500,1,0,0:0:0:0:
300,300,2000,1,0,0:0:0:0:
100,300,2500,1,0,0:0:0:0:
256,192,3000,12,0,4000,0:0:0:0:
200,200,4500,2,0,L|300:200,1,100
"""

NOTES = [(1000, 100, 100), (1500, 300, 100), (2000, 300, 300), (2500, 100, 300), (4500, 200, 200)]


def build_frames(flip):
    """Cursor sits on each note at its time and taps it (alternating K1/K2), ~16 ms frames."""
    frames = [(0, 256, -500, 0), (-1, 256, -500, 0)]
    t_prev = -1
    events = []
    for i, (t, x, y) in enumerate(NOTES):
        key = 5 if i % 2 == 0 else 10
        events.append((t, x, y, key))
        events.append((t + 40, x, y, 0))
    pos = (256, 192)
    key = 0
    t = 16
    ev = 0
    while t <= 5200:
        while ev < len(events) and events[ev][0] <= t:
            et, ex, ey, key = events[ev]
            yy = 384 - ey if flip else ey
            frames.append((et - t_prev, ex, yy, key))
            t_prev = et
            pos = (ex, ey)
            ev += 1
        if t > t_prev:
            yy = 384 - pos[1] if flip else pos[1]
            frames.append((t - t_prev, pos[0], yy, key))
            t_prev = t
        t += 16
    text = ','.join(f'{w}|{x}|{y}|{z}' for (w, x, y, z) in frames) + ',-12345|0|0|7777777,'
    return text.encode('ascii')


def osr(mode, mods, beatmap_md5, frames_bytes, player='FixturePlayer', known_size=False):
    comp = lzma.compress(frames_bytes, format=lzma.FORMAT_ALONE)
    if known_size:
        comp = comp[:5] + struct.pack('<Q', len(frames_bytes)) + comp[13:]
    ticks = PLAYED_AT_MS * 10000 + TICKS_AT_EPOCH
    out = bytearray()
    out += struct.pack('<Bi', mode, 20250107)
    replay_md5 = hashlib.md5(frames_bytes + bytes([mode, mods & 0xFF]) + player.encode() + beatmap_md5.encode()).hexdigest()
    out += ostr(beatmap_md5) + ostr(player) + ostr(replay_md5)
    out += struct.pack('<6H', 4, 0, 0, 0, 0, 0)
    out += struct.pack('<iHB', 123456, 4, 1)
    out += struct.pack('<i', mods)
    out += ostr('')
    out += struct.pack('<q', ticks)
    out += struct.pack('<i', len(comp)) + comp
    out += struct.pack('<q', 0)
    return bytes(out)


def db_entry(version, md5, folder, fname, beatmap_id, set_id, title, diff):
    float_diff = version >= 20140609
    body = bytearray()
    for s in ['Artist', 'ArtistU', title, title + 'U', 'Creator', diff, 'audio.mp3', md5, fname]:
        body += ostr(s)
    body += struct.pack('<B3hq', 4, 10, 5, 1, 638398406450000000)
    body += struct.pack('<4f', 9, 4, 5, 8) if float_diff else struct.pack('<4B', 9, 4, 5, 8)
    body += struct.pack('<d', 1.4)
    if float_diff:
        for _ in range(4):
            pairs = [(0, 5.5), (16, 6.1)]
            body += struct.pack('<i', len(pairs))
            for mods, sr in pairs:
                if version >= 20250107:
                    body += struct.pack('<BiBf', 0x08, mods, 0x0C, sr)
                else:
                    body += struct.pack('<BiBd', 0x08, mods, 0x0D, sr)
    body += struct.pack('<iii', 120, 125000, 30000)
    body += struct.pack('<i', 2) + struct.pack('<dd?', 500.0, 0.0, True) + struct.pack('<dd?', -50.0, 1000.0, False)
    body += struct.pack('<iii', beatmap_id, set_id, 0)
    body += struct.pack('<4B', 9, 9, 9, 9) + struct.pack('<h', 0) + struct.pack('<f', 0.7) + struct.pack('<B', 0)
    body += ostr('source') + ostr('tag1 tag2') + struct.pack('<h', 0) + ostr(None)
    body += struct.pack('<?q?', False, 638398406450000000, False)
    body += ostr(folder)
    body += struct.pack('<q', 638398406450000000) + struct.pack('<5?', False, False, False, False, False)
    if not float_diff:
        body += struct.pack('<h', 0)
    body += struct.pack('<iB', 0, 0)
    if version < 20191106:
        return struct.pack('<i', len(body)) + bytes(body)
    return bytes(body)


def osudb(version):
    entries = [
        ('a' * 32, '123 Artist - Song', 'Artist - Song (Mapper) [Hard].osu', 1001, 2002, 'Song', 'Hard'),
        ('b' * 32, '456 Other - Tune', 'Other - Tune (Mapper) [Insane].osu', 0, -1, 'Tune', 'Insane'),
    ]
    out = bytearray()
    out += struct.pack('<ii?q', version, 2, True, 0) + ostr('DbPlayer') + struct.pack('<i', len(entries))
    for e in entries:
        out += db_entry(version, *e)
    out += struct.pack('<i', 0)
    return bytes(out)


def complex_map(version, seed, legacy=False):
    """A generated map exercising every curve type, red anchors, repeats, spinners, SV and BPM changes."""
    rnd = random.Random(seed)
    lines = [f'osu file format v{version}', '', '[General]', 'Mode: 0', 'StackLeniency: 0.7', '',
             '[Metadata]', f'Title:Generated Fixture {seed}', 'Artist:osu-replay-ghost', 'Creator:make_fixtures.py',
             'Version:Geometry', 'BeatmapID:0', 'BeatmapSetID:-1', '',
             '[Difficulty]', 'HPDrainRate:5', 'CircleSize:4', 'OverallDifficulty:7']
    if not legacy:
        lines.append('ApproachRate:9')
    lines += ['SliderMultiplier:1.7', 'SliderTickRate:1', '', '[TimingPoints]']
    tp = lambda t, bl, red: f'{t},{bl}' if legacy else f'{t},{bl},4,1,0,80,{1 if red else 0},0'
    lines.append(tp(500, 400, True))
    objects = []
    t = 1000
    for i in range(160):
        if i == 80:
            lines.append(tp(t, 300, True))
        if i % 10 == 3:
            lines.append(tp(t, -100 / rnd.choice([0.5, 0.75, 1.5, 2.0]), False))
        x, y = rnd.randint(40, 470), rnd.randint(40, 340)
        nc = 4 if i % 8 == 0 else 0
        skip = (rnd.randint(1, 3) << 4) if i % 24 == 0 and i else 0
        kind = i % 12
        pt = lambda: f'{rnd.randint(30, 480)}:{rnd.randint(30, 350)}'
        if kind == 11:
            objects.append(f'256,192,{t},{8 | nc},0,{t + 1500},0:0:0:0:')
            t += 2000
            continue
        if kind in (2, 5, 7, 9):
            slides = rnd.choice([1, 1, 2, 3])
            length = rnd.randint(60, 260)
            if kind == 2:
                curve = f'P|{pt()}|{pt()}'
            elif kind == 5:
                a, b = pt(), pt()
                curve = f'B|{pt()}|{a}|{a}|{b}|{pt()}'  # red anchor
            elif kind == 7:
                curve = f'L|{pt()}'
            else:
                curve = f'C|{pt()}|{pt()}|{pt()}' if not legacy else f'B|{x}:{y}|{pt()}|{pt()}'  # legacy: head repeated
            objects.append(f'{x},{y},{t},{2 | nc | skip},0,{curve},{slides},{length}')
            t += 900
        else:
            objects.append(f'{x},{y},{t},{1 | nc | skip},0,0:0:0:0:')
            t += rnd.choice([150, 200, 300])
    lines += ['', '[HitObjects]'] + objects + ['']
    return '\r\n'.join(lines).encode('utf-8')


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, data in {
        'gen_v14_geometry.osu': complex_map(14, 1),
        'gen_v14_red_anchors.osu': complex_map(14, 2),
        'gen_v5_legacy.osu': complex_map(5, 3, legacy=True),
    }.items():
        with open(os.path.join(OUT, name), 'wb') as f:
            f.write(data)
    map_bytes = MAP.replace('\n', '\r\n').encode('utf-8')
    with open(os.path.join(OUT, 'fixture_map.osu'), 'wb') as f:
        f.write(map_bytes)
    md5 = hashlib.md5(map_bytes).hexdigest()
    nm = osr(0, 0, md5, build_frames(False))
    files = {
        'replay_nm.osr': nm,
        'replay_nm_known_size.osr': osr(0, 0, md5, build_frames(False), known_size=True),
        'replay_hr.osr': osr(0, 16, md5, build_frames(True), player='HRPlayer'),
        'replay_taiko.osr': osr(1, 0, md5, build_frames(False), player='TaikoPlayer'),
        'replay_truncated.osr': nm[: len(nm) - 60],
        'replay_missing_map.osr': osr(0, 0, 'f' * 32, build_frames(False), player='Orphan'),
        'osudb_20140101.db': osudb(20140101),
        'osudb_20191105.db': osudb(20191105),
        'osudb_20191106.db': osudb(20191106),
        'osudb_20250107.db': osudb(20250107),
    }
    for name, data in files.items():
        with open(os.path.join(OUT, name), 'wb') as f:
            f.write(data)
    print('fixture map md5', md5)


if __name__ == '__main__':
    main()
