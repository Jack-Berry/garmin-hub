/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // Design-system fonts (Stage 7). `sans` stays Inter until the full rollout.
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: 'var(--font-display)',
        body: 'var(--font-body)',
        mono: 'var(--font-mono)',
      },
      // Token-driven colours — all resolve to CSS vars (light/dark via .dark).
      colors: {
        surface: {
          0: 'var(--surface-0)',
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
        },
        ink: {
          DEFAULT: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
        },
        line: 'var(--border)',
        acc: {
          DEFAULT: 'var(--acc)',
          ink: 'var(--acc-ink)', // foreground on an accent fill
        },
        sem: {
          amber: 'var(--sem-amber)',
          red: 'var(--sem-red)',
          violet: 'var(--sem-violet)',
          blue: 'var(--sem-blue)',
        },
      },
      // Type scale from the reference (hero 56px → 9px labels). Tracking is
      // applied with utilities (tight for display, wide for uppercase labels).
      fontSize: {
        display: ['3.5rem', { lineHeight: '1' }], // 56
        title: ['1.4375rem', { lineHeight: '1.15' }], // 23
        heading: ['1.0625rem', { lineHeight: '1.25' }], // 17
        data: ['1.1875rem', { lineHeight: '1.2' }], // 19 — mono readouts
        body: ['0.875rem', { lineHeight: '1.45' }], // 14
        label: ['0.6875rem', { lineHeight: '1' }], // 11
        micro: ['0.625rem', { lineHeight: '1' }], // 10
        nano: ['0.5625rem', { lineHeight: '1' }], // 9
      },
    },
  },
  plugins: [],
};
