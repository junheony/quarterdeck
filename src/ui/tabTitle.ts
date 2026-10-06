export const APP_TITLE = 'deck';

/**
 * The browser tab / PWA window title: the focused chat's title (Desktop shows it in the window bar), after the
 * status mark — ● while any turn runs, ✓ when one finished while the tab was hidden.
 */
export function tabTitle(mark: '●' | '✓' | null, chat: string | null | undefined): string {
  const name = chat?.trim();
  const base = name ? `${name} — ${APP_TITLE}` : APP_TITLE;
  return mark ? `${mark} ${base}` : base;
}
