import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DirError, isUnderRoots, listDirs, resolveUnderHome } from './dirs';

let home: string;
let outside: string;

beforeAll(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-home-')));
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-outside-')));
  await fs.mkdir(path.join(home, 'Documents', '작업', 'deck'), { recursive: true });
  await fs.mkdir(path.join(home, 'Documents', 'b-proj'));
  await fs.mkdir(path.join(home, 'Documents', '.hidden'));
  await fs.writeFile(path.join(home, 'Documents', 'file.txt'), 'x');
  await fs.symlink(outside, path.join(home, 'escape'));
  await fs.symlink(path.join(home, 'Documents'), path.join(home, 'docs-link'));
});
afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe('resolveUnderHome', () => {
  it('expands ~ and ~/ and accepts absolute paths under home', async () => {
    expect(await resolveUnderHome('~', home)).toBe(home);
    expect(await resolveUnderHome('~/', home)).toBe(home);
    expect(await resolveUnderHome('~/Documents/작업', home)).toBe(path.join(home, 'Documents', '작업'));
    expect(await resolveUnderHome(path.join(home, 'Documents'), home)).toBe(path.join(home, 'Documents'));
  });

  it('resolves a symlink that stays under home to its real path', async () => {
    expect(await resolveUnderHome('~/docs-link', home)).toBe(path.join(home, 'Documents'));
  });

  it('rejects paths outside home, symlinks escaping home, .. escapes, relative paths and ~user', async () => {
    for (const p of [outside, '/', '~/escape', '~/../', `${home}/../`, 'relative/dir', '~other/x', '']) {
      await expect(resolveUnderHome(p, home)).rejects.toBeInstanceOf(DirError);
    }
    await expect(resolveUnderHome('~/escape', home)).rejects.toThrow('홈 폴더 안의 경로만');
  });

  it('rejects files and missing paths with Korean messages', async () => {
    await expect(resolveUnderHome('~/Documents/file.txt', home)).rejects.toThrow('폴더가 아닙니다');
    await expect(resolveUnderHome('~/nope', home)).rejects.toThrow('폴더를 찾을 수 없습니다');
  });
});

describe('isUnderRoots', () => {
  it('is true for a root itself and its descendants only', () => {
    expect(isUnderRoots('/a/b', ['/a/b'])).toBe(true);
    expect(isUnderRoots('/a/b/c', ['/x', '/a/b'])).toBe(true);
    expect(isUnderRoots('/a/bc', ['/a/b'])).toBe(false);
    expect(isUnderRoots('/a', ['/a/b'])).toBe(false);
  });
});

describe('listDirs', () => {
  it('lists non-hidden subdirectories only, sorted, with parent', async () => {
    const r = await listDirs('~/Documents', home);
    expect(r.path).toBe(path.join(home, 'Documents'));
    expect(r.parent).toBe(home);
    expect(r.dirs).toEqual([
      { name: 'b-proj', path: path.join(home, 'Documents', 'b-proj') },
      { name: '작업', path: path.join(home, 'Documents', '작업') },
    ]);
  });

  it('home itself has no parent and never lists symlinks (no escape through a listed entry)', async () => {
    const r = await listDirs('~', home);
    expect(r.parent).toBeNull();
    expect(r.dirs.map((d) => d.name)).toEqual(['Documents']);
  });

  it('caps the listing', async () => {
    const many = path.join(home, 'many');
    await fs.mkdir(many);
    for (let i = 0; i < 12; i++) await fs.mkdir(path.join(many, `d${String(i).padStart(2, '0')}`));
    const r = await listDirs('~/many', home, 5);
    expect(r.dirs.map((d) => d.name)).toEqual(['d00', 'd01', 'd02', 'd03', 'd04']);
  });

  it('rejects outside home', async () => {
    await expect(listDirs(outside, home)).rejects.toBeInstanceOf(DirError);
  });
});
