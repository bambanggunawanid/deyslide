import { defineConfig } from 'unocss'

/**
 * Deyslide design tokens. Slidev merges this file with its own UnoCSS
 * config, so only project specific pieces live here.
 */
export default defineConfig({
  theme: {
    colors: {
      dey: {
        bg: '#0b1020',
        panel: '#111827',
        line: '#1e293b',
        text: '#e2e8f0',
        muted: '#94a3b8',
        accent: '#38bdf8',
        violet: '#a78bfa',
        ok: '#34d399',
        warn: '#fbbf24',
        pink: '#f472b6',
      },
    },
  },
  shortcuts: {
    'dey-panel': 'rounded-xl border border-dey-line bg-dey-panel/80 p-4 shadow-lg shadow-black/30 backdrop-blur',
    'dey-btn': 'rounded-md border border-slate-600 bg-slate-800 px-3 py-1 text-slate-100 transition-colors hover:border-dey-accent hover:text-dey-accent disabled:cursor-not-allowed disabled:opacity-40',
    'dey-chip': 'inline-flex items-center gap-1 rounded-full border border-dey-line bg-black/30 px-3 py-0.5 text-xs uppercase tracking-wider text-dey-muted',
    'dey-title': 'text-dey-accent',
  },
  safelist: ['left-5.5', 'left-0.5'],
})
