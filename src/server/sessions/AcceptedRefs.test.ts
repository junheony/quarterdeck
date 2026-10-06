import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ACCEPTED_REFS_MAX, ACCEPTED_REFS_TTL_MS, AcceptedRefs } from './AcceptedRefs';

const S = '11111111-1111-4111-8111-111111111111';
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'deck-refs-'));

describe('AcceptedRefs', () => {
  it('records per session and is still known after a restart (a new instance on the same file)', async () => {
    const file = path.join(await tmp(), 'cfg', 'accepted-refs.json');
    const a = new AcceptedRefs(file);
    a.add(S, 'tab-1');
    a.add(S, 'tab-2');
    a.add(S, 'tab-1');
    a.add('other', 'x');
    expect(a.list(S)).toEqual(['tab-2', 'tab-1']);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const b = new AcceptedRefs(file);
    expect(b.list(S)).toEqual(['tab-2', 'tab-1']);
    expect(b.list('other')).toEqual(['x']);
    expect(b.list('none')).toEqual([]);
  });

  it('keeps the last ACCEPTED_REFS_MAX per session and forgets refs older than the TTL', async () => {
    let t = 1_000_000;
    const a = new AcceptedRefs(null, () => t);
    for (let i = 0; i < ACCEPTED_REFS_MAX + 5; i++) a.add(S, `r${i}`);
    expect(a.list(S)).toHaveLength(ACCEPTED_REFS_MAX);
    expect(a.list(S)[0]).toBe('r5');
    t += ACCEPTED_REFS_TTL_MS + 1;
    expect(a.list(S)).toEqual([]);
  });

  it('since: the oldest kept ref\'s time once the cap may have evicted older ones (also after a restart); remove takes a ref back', async () => {
    const file = path.join(await tmp(), 'accepted-refs.json');
    let t = 1_000_000;
    const a = new AcceptedRefs(file, () => t);
    for (let i = 0; i < ACCEPTED_REFS_MAX - 1; i++) { a.add(S, `r${i}`); t += 1; }
    expect(a.since(S)).toBeUndefined();
    a.add(S, 'last'); t += 1;
    a.add(S, 'over');
    expect(a.since(S)).toBe(1_000_001);
    expect(new AcceptedRefs(file, () => t).since(S)).toBe(1_000_001);
    a.remove(S, 'over');
    expect(a.has(S, 'over')).toBe(false);
    expect(new AcceptedRefs(file, () => t).has(S, 'over')).toBe(false);
    expect(a.since(S)).toBeUndefined();
  });

  it('a missing or corrupt file starts empty', async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, 'bad.json'), '{not json');
    expect(new AcceptedRefs(path.join(dir, 'bad.json')).list(S)).toEqual([]);
    expect(new AcceptedRefs(path.join(dir, 'missing.json')).list(S)).toEqual([]);
  });
});
