import { createContext, useContext, useEffect, useState } from 'react';
import {
  applyAccent, accentValue, ACCENT_STORAGE_KEY, DEFAULT_ACCENT, ACCENTS,
} from './accents';

// Accent theming context. Holds the selected accent, applies it to the document
// (CSS vars, live), persists it to localStorage, and exposes the resolved hex so
// chart components — which can't read CSS var() in SVG strokes — follow along.
const AccentCtx = createContext(null);

export function AccentProvider({ dark, children }) {
  const [accent, setAccentState] = useState(() => {
    const saved = localStorage.getItem(ACCENT_STORAGE_KEY);
    return saved && ACCENTS[saved] ? saved : DEFAULT_ACCENT;
  });

  // Re-apply whenever the accent OR the theme flips (the hex differs per mode).
  useEffect(() => {
    applyAccent(accent, dark);
  }, [accent, dark]);

  const setAccent = (key) => {
    if (!ACCENTS[key]) return;
    localStorage.setItem(ACCENT_STORAGE_KEY, key);
    setAccentState(key);
  };

  // Chart hex, resolved for the current mode — changes => chart consumers re-render.
  const accentHex = accentValue(accent, dark)[0];

  return (
    <AccentCtx.Provider value={{ accent, setAccent, accentHex }}>
      {children}
    </AccentCtx.Provider>
  );
}

export const useAccent = () => useContext(AccentCtx);
export const useAccentHex = () => useContext(AccentCtx).accentHex;
