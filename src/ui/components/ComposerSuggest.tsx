import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent } from 'react';
import { applySuggestion, detectTrigger, mentionFor, rankCommands, rankFiles, type CommandItem } from '../autocomplete';
import { listCommands, listFiles } from '../sessionApi';

const SHOW = 50;

type Item = { key: string; label: string; detail: string; insert: string };

/**
 * `@` file mentions (files under the pane's cwd, from /api/files) and leading `/` commands (from /api/commands)
 * for the composer textarea. The caller wires `track` to the textarea's onChange/onSelect, calls `onKeyDown` first
 * in its own key handler (true = handled), and renders `popup` inside the composer.
 */
export function useComposerSuggest({ text, setText, textareaRef, cwd, sessionId, commands, extraCommands, fetchFn }: {
  text: string;
  setText: (t: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  cwd?: string;
  sessionId: string | null;
  /** False for engines without slash commands (GPT sessions). */
  commands: boolean;
  /** deck's own commands (e.g. /handoff), listed before the server's. */
  extraCommands?: CommandItem[];
  fetchFn?: typeof fetch;
}): { track: (e: SyntheticEvent<HTMLTextAreaElement>) => void; onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean; popup: ReactNode } {
  const [cursor, setCursor] = useState(0);
  const [fileLists, setFileLists] = useState<Record<string, { list: string[]; error: string | null; loading: boolean }>>({});
  const [cmdLists, setCmdLists] = useState<Record<string, CommandItem[]>>({});
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const raw = detectTrigger(text, Math.min(cursor, text.length));
  const trigger = raw && (raw.kind === 'file' ? !!cwd : commands) ? raw : null;
  const tKey = trigger ? `${trigger.kind}:${trigger.start}` : null;
  const cmdKey = `${sessionId ?? ''}|${cwd ?? ''}`;

  // Fetched once per cwd / per session+cwd, kept under that key (a late answer for another cwd does not clobber this one).
  const asked = useRef({ files: new Set<string>(), cmds: new Set<string>() });
  useEffect(() => {
    if (trigger?.kind !== 'file' || !cwd || asked.current.files.has(cwd)) return;
    asked.current.files.add(cwd);
    const put = (v: { list: string[]; error: string | null; loading: boolean }) => setFileLists((m) => ({ ...m, [cwd]: v }));
    put({ list: [], error: null, loading: true });
    listFiles(cwd, fetchFn).then(
      (r) => put({ list: r.files, error: null, loading: false }),
      (err: unknown) => { asked.current.files.delete(cwd); put({ list: [], error: err instanceof Error ? err.message : '파일 목록 실패', loading: false }); },
    );
  }, [trigger?.kind, cwd, fetchFn]);

  useEffect(() => {
    if (trigger?.kind !== 'command' || asked.current.cmds.has(cmdKey)) return;
    asked.current.cmds.add(cmdKey);
    listCommands(sessionId, cwd ?? null, fetchFn).then((r) => setCmdLists((m) => ({ ...m, [cmdKey]: r.commands })), () => setCmdLists((m) => ({ ...m, [cmdKey]: [] })));
  }, [trigger?.kind, cmdKey, sessionId, cwd, fetchFn]);

  // A new token (or none) re-arms the popup and resets the highlight.
  useEffect(() => { setSel(0); if (tKey === null) setDismissed(null); }, [tKey, trigger?.query]);

  const files = cwd ? fileLists[cwd] : undefined;
  const cmds = cmdLists[cmdKey];
  const items: Item[] = !trigger
    ? []
    : trigger.kind === 'file'
      ? rankFiles(trigger.query, files?.list ?? [], SHOW).map((f) => ({ key: f, label: f, detail: '', insert: mentionFor(f) }))
      : rankCommands(trigger.query, [...(extraCommands ?? []), ...(cmds ?? []).filter((c) => !extraCommands?.some((x) => x.name === c.name))], SHOW).map((c) => ({ key: c.name, label: `/${c.name}`, detail: [c.argumentHint, c.description].filter(Boolean).join(' · '), insert: `/${c.name}` }));
  const open = !!trigger && tKey !== dismissed;
  const fileError = trigger?.kind === 'file' ? (files?.error ?? null) : null;

  const apply = (it: Item) => {
    if (!trigger) return;
    const next = applySuggestion(text, trigger, it.insert);
    setText(next.text);
    setCursor(next.cursor);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(next.cursor, next.cursor); }
    });
  };

  const track = (e: SyntheticEvent<HTMLTextAreaElement>) => setCursor(e.currentTarget.selectionStart ?? e.currentTarget.value.length);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === 'Escape') { e.preventDefault(); setDismissed(tKey); return true; }
    if (items.length === 0) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      apply(items[Math.min(sel, items.length - 1)]!);
      return true;
    }
    return false;
  };

  const loading = trigger?.kind === 'file' ? !files || files.loading : !cmds;
  const popup = open && (items.length > 0 || fileError || (loading && trigger.query === '')) ? (
    <div className="suggest" data-testid="composer-suggest">
      {items.length > 0 ? (
        <ul role="listbox" aria-label={trigger.kind === 'file' ? '파일' : '명령'}>
          {items.map((it, i) => (
            <li key={it.key} role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''}
              onMouseDown={(e) => { e.preventDefault(); apply(it); }} onMouseEnter={() => setSel(i)}>
              <span className="suggest-label">{it.label}</span>
              {it.detail && <span className="suggest-detail">{it.detail}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="suggest-empty muted">{fileError ?? '불러오는 중…'}</div>
      )}
    </div>
  ) : null;

  return { track, onKeyDown, popup };
}
