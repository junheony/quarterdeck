/// <reference types="vite/client" />
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { applyPrefs, loadPrefs } from './prefs';
import { pinShell, relaxViewport, watchShell } from './shellFit';

// Before the first render (no inline script: the CSP forbids it) so a saved theme/font size doesn't flash.
applyPrefs(loadPrefs());
relaxViewport();
pinShell();
watchShell();

createRoot(document.getElementById('root')!).render(<App />);

// PWA: offline shell + Web Push. Production build only (in dev Vite serves changing, unhashed modules).
if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
}
