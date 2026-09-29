/** Shortcuts from Slidev's UnoCSS config that its layouts and styles rely on. */
export const SLIDEV_SHORTCUTS: Record<string, string> = {
  'bg-main': 'bg-white dark:bg-[#121212]',
  'bg-active': 'bg-gray-400/10',
  'border-main': 'border-gray/20',
  'text-main': 'text-[#181818] dark:text-[#ddd]',
  'text-primary': 'color-$slidev-theme-primary',
  'bg-primary': 'bg-$slidev-theme-primary',
  'border-primary': 'border-$slidev-theme-primary',
  'abs-tl': 'absolute top-0 left-0',
  'abs-tr': 'absolute top-0 right-0',
  'abs-b': 'absolute bottom-0 left-0 right-0',
  'abs-bl': 'absolute bottom-0 left-0',
  'abs-br': 'absolute bottom-0 right-0',
}
