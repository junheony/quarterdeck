/**
 * iOS / iPadOS home-screen app: a dead band the height of the status bar shows under the shell, and nothing the page
 * draws reaches it (a taller pinned box and a taller document were both clipped at the same line). Until the cause is
 * known this only reports what the device says about its viewport: to the server log, and as one line in 설정 → 정보.
 */
export type ShellMetrics = { standalone: boolean; inner: number; outer: number; vvHeight: number | null; safeTop: number };

let probe: HTMLElement | null = null;
function safeTop(): number {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none';
    document.documentElement.appendChild(probe);
  }
  return Math.round(probe.getBoundingClientRect().height);
}

export function readShellMetrics(): ShellMetrics {
  const vv = window.visualViewport ?? null;
  return {
    standalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
    inner: window.innerHeight,
    outer: window.outerHeight,
    vvHeight: vv ? vv.height : null,
    safeTop: safeTop(),
  };
}

export const isHomeScreenApp = (): boolean => typeof navigator !== 'undefined' && (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** A viewport unit / inset in px, as this device resolves it. */
function px(css: string): number {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;top:0;left:0;width:0;height:${css};visibility:hidden;pointer-events:none`;
  document.documentElement.appendChild(el);
  const h = el.getBoundingClientRect().height;
  el.remove();
  return Math.round(h * 10) / 10;
}
const box = (el: Element | null): number[] | null => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10);
};

/** Everything the device says about its viewport, for the server log (POST /api/diag). */
export function shellReport(why: string): Record<string, unknown> {
  const vv = window.visualViewport ?? null;
  const de = document.documentElement;
  const active = document.activeElement;
  return {
    why,
    inner: [window.innerWidth, window.innerHeight],
    outer: [window.outerWidth, window.outerHeight],
    screen: [screen.width, screen.height, screen.availWidth, screen.availHeight],
    client: [de.clientWidth, de.clientHeight],
    scroll: [window.scrollX, window.scrollY, de.scrollHeight],
    vv: vv ? [vv.width, vv.height, vv.offsetLeft, vv.offsetTop, vv.pageTop, vv.scale].map((n) => Math.round(n * 10) / 10) : null,
    units: { vh: px('100vh'), dvh: px('100dvh'), svh: px('100svh'), lvh: px('100lvh'), pct: px('100%') },
    safe: [px('env(safe-area-inset-top,0px)'), px('env(safe-area-inset-right,0px)'), px('env(safe-area-inset-bottom,0px)'), px('env(safe-area-inset-left,0px)')],
    app: box(document.querySelector('.app')),
    composer: box(document.querySelector('.composer-wrap')),
    focus: active && active !== document.body ? [active.tagName, ...(box(active) ?? [])] : null,
    softKb: de.hasAttribute('data-soft-kb'),
    standalone: isHomeScreenApp(),
    dpr: window.devicePixelRatio,
    orient: screen.orientation?.type ?? null,
    viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null,
    pins,
    ua: navigator.userAgent,
  };
}

let lastSent = '';
let timer: ReturnType<typeof setTimeout> | undefined;
/** Sends the report once things settle; an unchanged one is not sent again. */
function reportSoon(why: string): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const report = shellReport(why);
    const sig = JSON.stringify({ ...report, why: '' });
    if (sig === lastSent) return;
    // Remembered only once the server took it: a report refused before sign-in is sent again later.
    void fetch('/api/diag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) })
      .then((r) => { if (r.ok) lastSent = sig; })
      .catch(() => undefined);
  }, 400);
}

/** One line for 설정 → 정보: what the device reports, for a screenshot when the bottom edge looks wrong. */
export function describeShell(): string {
  const m = readShellMetrics();
  return `${window.innerWidth}×${m.inner} · 창 ${m.outer} · 화면 ${screen.width}×${screen.height} · 보이는 ${m.vvHeight === null ? '-' : Math.round(m.vvHeight)} · 위 ${m.safeTop}${m.standalone ? ' · 앱' : ''}`;
}

/**
 * iPad home-screen app only: drops `viewport-fit=cover`. On iPadOS 26 the web view there keeps a status-bar-high top inset
 * on its scroll view even though the page is told to cover it (reports show the page resting at scrollY 0 with a dead band
 * below it, or at scrollY -32 with its bottom cut off, and the caret drawn that far below the text). Without cover the
 * system owns that strip and the page is laid out under it. Phones keep cover (notch / home indicator).
 */
function isIPadApp(): boolean {
  const iPad = /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return iPad && isHomeScreenApp();
}

export function relaxViewport(): void {
  if (!isIPadApp()) return;
  const meta = document.querySelector('meta[name="viewport"]');
  const content = meta?.getAttribute('content');
  if (meta && content) meta.setAttribute('content', content.split(',').map((x) => x.trim()).filter((x) => x !== 'viewport-fit=cover').join(', '));
}

let pins = 0;
/** Largest slip put back: the status bar is 24–32 pt; the keyboard pans the view by far more. */
const PIN_MAX = 48;
/**
 * iPad home-screen app: the page has nothing to scroll (the shell is a fixed box), yet focusing the composer pans the
 * view by a status bar's height (reports: scrollY 32, shell top −32) — the top slides under the status bar, a band
 * opens below and the caret is drawn that far from its text. With no on-screen keyboard and no zoom there is no reason
 * for the view to be anywhere but the top, so it is put back. Left alone while the keyboard is up or the page is zoomed.
 */
export function pinShell(): void {
  if (!isIPadApp()) return;
  const vv = window.visualViewport;
  const settle = () => {
    if (vv && (Math.abs(vv.scale - 1) > 0.01 || vv.height < window.innerHeight - 1)) return;
    if (document.documentElement.hasAttribute('data-soft-kb')) return;
    const y = Math.abs(window.scrollY);
    const top = Math.abs(vv?.offsetTop ?? 0);
    if (y < 1 && top < 1) return;
    // Only the status-bar-sized slip; a larger pan is the system lifting the composer above a keyboard still on its way up.
    if (y > PIN_MAX || top > PIN_MAX) return;
    pins += 1;
    window.scrollTo(0, 0);
  };
  let pending = false;
  const soon = () => {
    settle();
    if (pending) return;
    pending = true;
    requestAnimationFrame(settle);
    setTimeout(settle, 120);
    setTimeout(() => { pending = false; settle(); }, 400);
  };
  vv?.addEventListener('scroll', soon);
  vv?.addEventListener('resize', soon);
  window.addEventListener('scroll', soon, { passive: true });
  document.addEventListener('focusin', soon);
  document.addEventListener('selectionchange', soon);
  window.addEventListener('pageshow', soon);
}

export function watchShell(): void {
  if (!isHomeScreenApp()) return;
  for (const ev of ['resize', 'orientationchange', 'pageshow', 'focus']) window.addEventListener(ev, () => reportSoon(ev));
  window.visualViewport?.addEventListener('resize', () => reportSoon('vv'));
  document.addEventListener('visibilitychange', () => reportSoon('visibility'));
  document.addEventListener('focusin', () => reportSoon('focusin'));
  for (const ms of [1500, 6000]) setTimeout(() => reportSoon('load'), ms);
}
