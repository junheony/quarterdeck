import { useEffect, useRef, useState } from 'react';

type Rec = { lang: string; continuous: boolean; interimResults: boolean; onresult: ((e: RecEvent) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; start(): void; stop(): void };
type RecEvent = { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> };
type RecCtor = new () => Rec;

export function recognitionCtor(w: object = window): RecCtor | null {
  const g = w as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

/** Composer mic: Web Speech dictation (ko-KR). Interim text replaces the dictated span of the draft; tap again to stop. Hidden when unsupported. */
export function DictationButton({ text, onText }: { text: string; onText: (t: string) => void }) {
  const Ctor = recognitionCtor();
  const [on, setOn] = useState(false);
  const rec = useRef<Rec | null>(null);
  const live = useRef({ text, onText });
  live.current = { text, onText };
  useEffect(() => () => rec.current?.stop(), []);
  if (!Ctor) return null;

  const toggle = () => {
    if (rec.current) { rec.current.stop(); return; }
    const r = new Ctor();
    r.lang = 'ko-KR';
    r.continuous = true;
    r.interimResults = true;
    // Text before dictation started stays; everything recognized so far is re-rendered after it.
    const base = live.current.text;
    const sep = base && !/\s$/.test(base) ? ' ' : '';
    r.onresult = (e) => {
      let said = '';
      for (let i = 0; i < e.results.length; i++) said += e.results[i]![0]!.transcript;
      live.current.onText(said ? base + sep + said : base);
    };
    const done = () => { rec.current = null; setOn(false); };
    r.onend = done;
    r.onerror = done;
    rec.current = r;
    setOn(true);
    try { r.start(); } catch { done(); }
  };

  return (
    <button type="button" className={`icon-btn dictate ${on ? 'on' : ''}`} onClick={toggle} aria-pressed={on} title={on ? '받아쓰기 중지' : '음성 받아쓰기'} aria-label={on ? '받아쓰기 중지' : '음성 받아쓰기'}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5.8" y="1.8" width="4.4" height="8" rx="2.2" /><path d="M3.4 7.8a4.6 4.6 0 0 0 9.2 0M8 12.4v2" /></svg>
    </button>
  );
}
