import { describe, expect, it } from 'vitest';
import { clampSideWidth, filePathIn, viewFor } from './sidePanel';

describe('filePathIn', () => {
  it('finds file paths, dropping :line', () => {
    expect(filePathIn('src/ui/App.tsx')).toBe('src/ui/App.tsx');
    expect(filePathIn('/abs/x.md:12')).toBe('/abs/x.md');
    expect(filePathIn('./a.py:3:4')).toBe('./a.py');
    expect(filePathIn('~/p/a.ts')).toBe('~/p/a.ts');
    expect(filePathIn('README.md')).toBe('README.md');
  });
  it('leaves code, versions, URLs and prose alone', () => {
    for (const t of ['console.log', 'a.b', '1.2.3', 'https://x.com/a.html', 'npm run build', 'foo', 'x.y.z()']) expect(filePathIn(t), t).toBeNull();
  });
});

describe('viewFor / clampSideWidth', () => {
  it('picks the view by extension', () => {
    expect(viewFor('a/README.md')).toBe('markdown');
    expect(viewFor('x.HTML')).toBe('html');
    expect(viewFor('i.svg')).toBe('html');
    expect(viewFor('p.png')).toBe('image');
    expect(viewFor('Makefile')).toBe('text');
  });
  it('keeps both the panel and the chat usable', () => {
    expect(clampSideWidth(100, 1000)).toBe(260);
    expect(clampSideWidth(900, 1000)).toBe(720);
    expect(clampSideWidth(400, 1000)).toBe(400);
  });
});
