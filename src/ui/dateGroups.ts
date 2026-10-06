/** Sidebar 최근 view: Desktop-style buckets by local calendar day. */
export const DATE_GROUPS = ['오늘', '어제', '지난 7일', '지난 30일', '이전'] as const;
export type DateGroup = (typeof DATE_GROUPS)[number];

/** Local midnight `daysAgo` days before `now` (calendar arithmetic, so DST days still count as one). */
function dayStart(now: number, daysAgo: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

export function dateGroupOf(ms: number, now: number = Date.now()): DateGroup {
  if (ms >= dayStart(now, 0)) return '오늘';
  if (ms >= dayStart(now, 1)) return '어제';
  if (ms >= dayStart(now, 6)) return '지난 7일';
  if (ms >= dayStart(now, 29)) return '지난 30일';
  return '이전';
}

/** Newest first, split into the non-empty buckets in DATE_GROUPS order. */
export function groupByDate<T extends { lastModified: number }>(items: T[], now: number = Date.now()): { label: DateGroup; items: T[] }[] {
  const sorted = [...items].sort((a, b) => b.lastModified - a.lastModified);
  const out = new Map<DateGroup, T[]>();
  for (const it of sorted) {
    const g = dateGroupOf(it.lastModified, now);
    out.set(g, [...(out.get(g) ?? []), it]);
  }
  return DATE_GROUPS.filter((g) => out.has(g)).map((label) => ({ label, items: out.get(label)! }));
}
