import { describe, expect, it } from 'vitest';
import { branchRoot, groupBranches, linksOf, versionsAt, type BranchLinks } from './branches';

// R: original. A, B: R's message 2 edited twice. C: A's message 4 edited. D: A's message 2 edited (a sibling of A, R, B).
const links: BranchLinks = {
  A: { parent: 'R', n: 2 },
  B: { parent: 'R', n: 2 },
  C: { parent: 'A', n: 4 },
  D: { parent: 'A', n: 2 },
};

describe('versionsAt', () => {
  it('lists every version of a message, oldest first, and which one the session shows', () => {
    expect(versionsAt(links, 'R', 2)).toEqual({ members: ['R', 'A', 'B', 'D'], index: 0 });
    expect(versionsAt(links, 'B', 2)).toEqual({ members: ['R', 'A', 'B', 'D'], index: 2 });
    expect(versionsAt(links, 'D', 2)).toEqual({ members: ['R', 'A', 'B', 'D'], index: 3 });
  });

  it('a deeper branch sees the versions of the messages it inherited', () => {
    // C inherited message 2 from A: it shows A's version.
    expect(versionsAt(links, 'C', 2)).toEqual({ members: ['R', 'A', 'B', 'D'], index: 1 });
    expect(versionsAt(links, 'C', 4)).toEqual({ members: ['A', 'C'], index: 1 });
    expect(versionsAt(links, 'A', 4)).toEqual({ members: ['A', 'C'], index: 0 });
  });

  it('null where there is one version only', () => {
    expect(versionsAt(links, 'R', 0)).toBeNull();
    expect(versionsAt(links, 'R', 4)).toBeNull(); // C branched from A, not R
    expect(versionsAt(links, 'B', 3)).toBeNull();
    expect(versionsAt({}, 'X', 0)).toBeNull();
  });

  it('survives a cycle in corrupt links', () => {
    expect(() => versionsAt({ X: { parent: 'Y', n: 1 }, Y: { parent: 'X', n: 1 } }, 'X', 1)).not.toThrow();
    expect(branchRoot({ X: { parent: 'Y', n: 1 }, Y: { parent: 'X', n: 1 } }, 'X')).toBeTypeOf('string');
  });
});

describe('groupBranches', () => {
  it('one row per tree: the root, dated and opened by the newest member', () => {
    const s = (sessionId: string, lastModified: number) => ({ sessionId, lastModified, title: sessionId });
    const groups = groupBranches([s('C', 50), s('X', 40), s('R', 10), s('A', 20), s('B', 30)], links);
    expect(groups.map((g) => [g.entry.sessionId, g.entry.lastModified, g.openId, g.members.length])).toEqual([
      ['R', 50, 'C', 4],
      ['X', 40, 'X', 1],
    ]);
    expect(groups[0]!.entry.title).toBe('R');
  });

  it('the oldest listed member heads a tree whose root is not listed', () => {
    const groups = groupBranches([{ sessionId: 'A', lastModified: 5 }, { sessionId: 'B', lastModified: 9 }], links);
    expect(groups).toEqual([{ entry: { sessionId: 'A', lastModified: 9 }, openId: 'B', members: ['A', 'B'] }]);
  });

  it('linksOf collects entry links', () => {
    expect(linksOf([{ sessionId: 'A', branch: { parent: 'R', n: 1 } }, { sessionId: 'R' }])).toEqual({ A: { parent: 'R', n: 1 } });
  });
});
