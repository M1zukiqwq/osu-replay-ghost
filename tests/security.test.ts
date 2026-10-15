import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('P3: external text is never parsed as HTML [B8]', () => {
  it('no HTML-injection sinks are used anywhere in src/', () => {
    const offenders = sourceFiles(join(__dirname, '..', 'src')).filter((f) =>
      /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('core logic does not touch the DOM (P4)', () => {
    const offenders = sourceFiles(join(__dirname, '..', 'src', 'core')).filter((f) =>
      /\b(document|window)\./.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('no runtime CDN dependencies (P9)', () => {
    const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
    expect(html).not.toMatch(/https?:\/\//);
  });
});
