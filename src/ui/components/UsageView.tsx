import { useCallback, useEffect, useState } from 'react';
import {
  FAMILY_LABEL, MODEL_FAMILIES, addCounts, addDays, cacheHitPct, costOf, emptyCounts, localDay, totalTokens, CODEX_SOURCE, usageSourceLabel, weekStart,
  type ModelFamily, type TokenCounts, type UsageHistory, type UsageRow, type UsageSource,
} from '../../shared/token-usage';
import { useAccounts, type UiAccounts } from '../accounts';

type View = UsageSource | 'all';
type Sum = TokenCounts & { cost: number };
/** Twelve weeks for the table; the totals and chart use the last 30 days of it. */
const FETCH_DAYS = 84;
const CHART_DAYS = 30;

/** "1.23B" / "45.6M" / "7.8K" / "12". */
export function fmtTokens(n: number): string {
  const f = (v: number, s: string) => `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}${s}`;
  if (n >= 1e9) return f(n / 1e9, 'B');
  if (n >= 1e6) return f(n / 1e6, 'M');
  if (n >= 1e3) return f(n / 1e3, 'K');
  return String(Math.round(n));
}

export function fmtCost(usd: number): string {
  return `$${usd >= 100 ? Math.round(usd).toLocaleString('en-US') : usd.toFixed(2)}`;
}

/** GPT/Codex runs on the ChatGPT subscription: no per-token bill, so the API-rate conversion is shown rounded ("약 $12"), never to the cent. */
export function fmtSubscriptionCost(usd: number): string {
  const r = usd >= 100 ? Math.round(usd / 10) * 10 : usd >= 10 ? Math.round(usd) : Math.round(usd * 10) / 10;
  return `구독 포함 · 약 $${r.toLocaleString('en-US')} 환산(추정)`;
}

function fmtPct(p: number | null): string {
  return p === null ? '—' : `${p.toFixed(1)}%`;
}

/** Sum of `view`'s rows whose day passes `inRange`, with the estimated cost priced per model family. */
export function sumRows(rows: UsageRow[], view: View, inRange: (day: string) => boolean = () => true): Sum {
  const s: Sum = { ...emptyCounts(), cost: 0 };
  for (const r of rows) {
    if (r.source !== view || !inRange(r.day)) continue;
    addCounts(s, r);
    s.cost += costOf(r, r.family);
  }
  return s;
}

/** Newest week first; weeks start on Monday. */
export function weeklyRows(rows: UsageRow[], view: View): { week: string; sum: Sum }[] {
  const weeks = new Map<string, UsageRow[]>();
  for (const r of rows) {
    if (r.source !== view) continue;
    const w = weekStart(r.day);
    weeks.set(w, [...(weeks.get(w) ?? []), r]);
  }
  return [...weeks.entries()].sort((x, y) => (x[0] < y[0] ? 1 : -1)).map(([week, rs]) => ({ week, sum: sumRows(rs, view) }));
}

/** Total tokens per day × family over the last `n` days ending `today`. */
export function dailyStacks(rows: UsageRow[], view: View, today: string, n: number): { day: string; parts: Partial<Record<ModelFamily, number>>; total: number }[] {
  const days = Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
  const at = new Map(days.map((d) => [d, { day: d, parts: {} as Partial<Record<ModelFamily, number>>, total: 0 }]));
  for (const r of rows) {
    const slot = r.source === view ? at.get(r.day) : undefined;
    if (!slot) continue;
    const t = totalTokens(r);
    slot.parts[r.family] = (slot.parts[r.family] ?? 0) + t;
    slot.total += t;
  }
  return days.map((d) => at.get(d)!);
}

/**
 * The tabs: 합계, the active accounts, then every other source that has rows — configured (retired) accounts in configured
 * order, then ids the configuration no longer has, in the index's order (`history.sources`; absent from an older server) —
 * and GPT last. `sources` alone never makes a tab: right after a start it is only `codex`, and an index moved from v1 lists a/b/c whatever is configured.
 */
export function usageTabs(names: Pick<UiAccounts, 'all'>, data: Pick<UsageHistory, 'sources' | 'rows'> | null): View[] {
  const withRows = new Set<string>();
  for (const r of data?.rows ?? []) if (r.source !== 'all' && r.source !== CODEX_SOURCE) withRows.add(r.source);
  const configured = names.all.filter((a) => !a.retired || withRows.has(a.id)).map((a) => a.id);
  const known = new Set(names.all.map((a) => a.id));
  const gone = [...new Set([...(data?.sources ?? []), ...withRows])].filter((s) => s !== CODEX_SOURCE && !known.has(s) && withRows.has(s));
  return ['all', ...configured, ...gone, CODEX_SOURCE];
}

function Tile({ label, s, sub }: { label: string; s: Sum; sub: boolean }) {
  return (
    <div className="uv-tile">
      <div className="uv-tile-label">{label}</div>
      <div className="uv-tile-value" title={`${totalTokens(s).toLocaleString('en-US')} 토큰`}>{fmtTokens(totalTokens(s))}</div>
      <div className="uv-tile-sub">
        {sub
          ? <span title="구독에 포함된 사용량입니다. API 단가로 환산한 대략적인 추정치이며 실제 청구액이 아닙니다">{fmtSubscriptionCost(s.cost)}</span>
          : <span title="추정 비용 — API 단가 기준, 실제 구독 요금과 다릅니다">{fmtCost(s.cost)} 추정</span>}
        <span>캐시 적중 {fmtPct(cacheHitPct(s))}</span>
      </div>
    </div>
  );
}

const CHART_W = 600;
const CHART_H = 180;

function DailyChart({ data }: { data: ReturnType<typeof dailyStacks> }) {
  const max = Math.max(1, ...data.map((d) => d.total));
  const present = MODEL_FAMILIES.filter((f) => data.some((d) => (d.parts[f] ?? 0) > 0));
  const slot = CHART_W / data.length;
  const bw = Math.max(2, slot - 4);
  return (
    <figure className="uv-chart">
      <figcaption className="uv-legend">
        {present.map((f) => <span key={f} className="uv-legend-item"><i className={`uv-swatch fam-${f}`} aria-hidden="true" />{FAMILY_LABEL[f]}</span>)}
        <span className="uv-legend-note">일별 합계 토큰 · 최고 {fmtTokens(max)}</span>
      </figcaption>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label={`최근 ${data.length}일 일별 토큰 사용량`} preserveAspectRatio="none" data-testid="usage-chart">
        <line x1={0} x2={CHART_W} y1={CHART_H} y2={CHART_H} className="uv-axis" />
        {data.map((d, i) => {
          let y = CHART_H;
          const x = i * slot + (slot - bw) / 2;
          const segs = present.map((f) => {
            const v = d.parts[f] ?? 0;
            if (!v) return null;
            const h = (v / max) * CHART_H;
            y -= h;
            // 2px surface gap between stacked segments.
            return <rect key={f} x={x} y={y + 1} width={bw} height={Math.max(0, h - 2)} className={`fam-${f}`} rx={1.5} />;
          });
          return (
            <g key={d.day} className="uv-bar">
              <title>{`${d.day} · ${fmtTokens(d.total)}${present.map((f) => (d.parts[f] ? `\n${FAMILY_LABEL[f]} ${fmtTokens(d.parts[f]!)}` : '')).join('')}`}</title>
              <rect x={i * slot} y={0} width={slot} height={CHART_H} className="uv-hit" />
              {segs}
            </g>
          );
        })}
      </svg>
      {/* Date ticks in HTML so they keep a readable size when the chart is squeezed to a phone width. */}
      <div className="uv-ticks" aria-hidden="true">
        {[0, Math.floor((data.length - 1) / 2), data.length - 1].map((i) => <span key={i}>{data[i]!.day.slice(5).replace('-', '/')}</span>)}
      </div>
    </figure>
  );
}

export function UsageView({ onClose, fetchFn = fetch, now }: { onClose: () => void; fetchFn?: typeof fetch; now?: Date }) {
  const [data, setData] = useState<UsageHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('all');
  const [busy, setBusy] = useState(false);
  const names = useAccounts();

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    try {
      const r = await fetchFn(`/api/usage/history?days=${FETCH_DAYS}${refresh ? '&refresh=1' : ''}`);
      if (!r.ok) throw new Error(`사용량을 불러오지 못했습니다 (${r.status})`);
      setData(await r.json() as UsageHistory);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '사용량을 불러오지 못했습니다');
    } finally {
      setBusy(false);
    }
  }, [fetchFn]);

  useEffect(() => { void load(false); }, [load]);
  // First scan of a large history runs in the background: poll until it is done.
  useEffect(() => {
    if (!data?.scanning) return;
    const id = setTimeout(() => void load(false), 5000);
    return () => clearTimeout(id);
  }, [data, load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const today = localDay(now ?? new Date());
  const rows = data?.rows ?? [];
  const week = weekStart(today);
  const month = addDays(today, -(CHART_DAYS - 1));
  // The picked tab may leave (a removed account whose rows aged out) and come back: 합계 meanwhile, the pick is kept.
  const tabs = usageTabs(names, data);
  const shown = tabs.includes(view) ? view : 'all';
  const weekly = weeklyRows(rows, shown);

  return (
    <div className="usage-shown" role="dialog" aria-modal="true" aria-label="토큰 사용량">
      <div className="uv-inner">
        <header className="uv-head">
          <h2>사용량</h2>
          <button type="button" className="uv-btn" onClick={() => void load(true)} disabled={busy}>{busy ? '읽는 중…' : '새로고침'}</button>
          <button type="button" className="uv-btn uv-close" onClick={onClose} aria-label="닫기">닫기</button>
        </header>
        <div className="uv-tabs" role="tablist" aria-label="계정">
          {tabs.map((v) => {
            const state = v === 'all' || v === CODEX_SOURCE ? null : names.state(v);
            const label = usageSourceLabel(v, names);
            return <button key={v} type="button" role="tab" aria-selected={shown === v} className={`${shown === v ? 'on' : ''}${state ? ` acct-${names.look(v).kind}` : ''}`} {...(state ? { title: `${label} (${state})`, 'aria-label': `${label} (${state})` } : {})} onClick={() => setView(v)}>{label}</button>;
          })}
        </div>
        {error && <div className="uv-note error">{error}</div>}
        {data?.scanning && <div className="uv-note">기록을 읽는 중입니다 — 처음에는 몇 분 걸릴 수 있어요. 숫자가 계속 늘어납니다.</div>}
        {shown === 'all' && <div className="uv-note muted">합계는 여러 계정에 복사된 같은 메시지를 한 번만 셉니다. 비용은 API 단가 기준 추정치이며, GPT(Codex)는 구독에 포함되어 환산값이 실제 청구액이 아닙니다.</div>}
        {shown === 'codex' && <div className="uv-note muted">GPT(Codex) 사용량은 ChatGPT 구독에 포함됩니다. 금액은 공개 단가가 없어 임의 단가로 환산한 대략적인 추정치입니다.</div>}
        <section className="uv-tiles">
          <Tile label="오늘" sub={shown === 'codex'} s={sumRows(rows, shown, (d) => d === today)} />
          <Tile label="이번 주" sub={shown === 'codex'} s={sumRows(rows, shown, (d) => d >= week && d <= today)} />
          <Tile label="30일" sub={shown === 'codex'} s={sumRows(rows, shown, (d) => d >= month && d <= today)} />
        </section>
        <section>
          <h3>일별 (최근 {CHART_DAYS}일)</h3>
          <DailyChart data={dailyStacks(rows, shown, today, CHART_DAYS)} />
        </section>
        <section>
          <h3>주별</h3>
          <div className="uv-table-wrap">
            <table className="uv-table" data-testid="usage-weekly">
              <thead>
                <tr><th>주 시작일</th><th>입력</th><th>출력</th><th>캐시 읽기</th><th>캐시 쓰기</th><th>합계</th><th>캐시 적중</th><th>추정 비용</th></tr>
              </thead>
              <tbody>
                {weekly.length === 0 && <tr><td colSpan={8} className="muted">{data ? '기록이 없습니다' : '불러오는 중…'}</td></tr>}
                {weekly.map(({ week: w, sum }) => (
                  <tr key={w}>
                    <th scope="row">{w}{w === week ? ' (이번 주)' : ''}</th>
                    <td>{fmtTokens(sum.input)}</td>
                    <td>{fmtTokens(sum.output)}</td>
                    <td>{fmtTokens(sum.cacheRead)}</td>
                    <td>{fmtTokens(sum.cacheWrite)}</td>
                    <td><b>{fmtTokens(totalTokens(sum))}</b></td>
                    <td>{fmtPct(cacheHitPct(sum))}</td>
                    <td>{shown === 'codex' ? fmtSubscriptionCost(sum.cost) : fmtCost(sum.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        {data?.lastScanAt && <div className="uv-foot muted">마지막 갱신 {new Date(data.lastScanAt).toLocaleString('ko-KR')} · 10분마다 자동 갱신</div>}
      </div>
    </div>
  );
}
