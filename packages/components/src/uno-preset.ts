import type { Preset } from 'unocss'

/**
 * Deyslide design tokens and shortcuts, shared by the Slidev deck and the
 * web app so slides and screens look the same. The components in this
 * package use these shortcuts (`dey-btn`, `dey-panel`).
 */
export function presetDeyslide(): Preset {
  return {
    name: 'deyslide',
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
      'dey-btn-primary': 'rounded-md border border-dey-accent bg-dey-accent px-3 py-1 font-medium text-dey-bg transition-colors hover:bg-sky-300 disabled:cursor-not-allowed disabled:opacity-40',
      'dey-chip': 'inline-flex items-center gap-1 rounded-full border border-dey-line bg-black/30 px-3 py-0.5 text-xs uppercase tracking-wider text-dey-muted',
      'dey-input': 'w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-dey-accent',
      'dey-title': 'text-dey-accent',
    },
    // DeyslideLiveSandbox builds these switch offsets from state.
    safelist: ['left-5.5', 'left-0.5'],
  }
}
