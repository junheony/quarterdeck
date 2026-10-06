import { useCallback, useEffect, useState } from 'react';
import { applyPrefs, loadPrefs, prefsReducer, savePrefs, type Prefs, type PrefsAction } from './prefs';

const CHANGE = 'deck:prefs';

/** Shared live prefs: every hook instance (Settings, Chat) follows a change made in any of them. */
export function usePrefs(): [Prefs, (a: PrefsAction) => void] {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  useEffect(() => {
    const on = () => setPrefs(loadPrefs());
    window.addEventListener(CHANGE, on);
    return () => window.removeEventListener(CHANGE, on);
  }, []);
  const dispatch = useCallback((a: PrefsAction) => {
    const next = prefsReducer(loadPrefs(), a);
    savePrefs(next);
    applyPrefs(next);
    window.dispatchEvent(new Event(CHANGE));
  }, []);
  return [prefs, dispatch];
}
