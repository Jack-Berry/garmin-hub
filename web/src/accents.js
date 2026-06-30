// User-selectable accent palette (Stage 7e). Each accent carries a dark- and a
// light-mode value plus its correct foreground (--acc-ink) for text-on-accent:
// bright accents (lime/amber/violet/blue) need dark ink; indigo takes white.
// Light-mode accents are darkened so they stay legible as text on white.
//
//   [accentColour, inkColour]  — `d` for dark mode, `l` for light mode.
//
// This map is the single source of truth: the Settings picker, the JS that sets
// the CSS vars, the chart hex, and the pre-paint <script> in index.html all read
// the same values (keep index.html's inline copy of the DARK values in sync).
export const ACCENTS = {
  lime: { label: 'Lime', d: ['#c9f24e', '#0b0b0d'], l: ['#5b7a00', '#ffffff'] },
  amber: { label: 'Amber', d: ['#f5a623', '#0b0b0d'], l: ['#9a6200', '#ffffff'] },
  violet: { label: 'Violet', d: ['#a78bfa', '#0b0b0d'], l: ['#6d28d9', '#ffffff'] },
  blue: { label: 'Blue', d: ['#38bdf8', '#0b0b0d'], l: ['#0369a1', '#ffffff'] },
  indigo: { label: 'Indigo', d: ['#6366f1', '#ffffff'], l: ['#4f46e5', '#ffffff'] },
};

export const ACCENT_KEYS = ['lime', 'amber', 'violet', 'blue', 'indigo'];
export const DEFAULT_ACCENT = 'lime';
export const ACCENT_STORAGE_KEY = 'gh:accent';

// Resolve an accent key (+ mode) to [accentHex, inkHex]. Unknown keys fall back.
export function accentValue(key, dark) {
  const a = ACCENTS[key] || ACCENTS[DEFAULT_ACCENT];
  return dark ? a.d : a.l;
}

// Apply an accent to the document. Sets the CSS vars on <html> so the value
// cascades into the nested .dark subtree (which intentionally doesn't define
// --acc). Returns the resolved accent hex (for charts, which can't read var()).
export function applyAccent(key, dark) {
  const [acc, ink] = accentValue(key, dark);
  const s = document.documentElement.style;
  s.setProperty('--acc', acc);
  s.setProperty('--acc-ink', ink);
  return acc;
}
