/** Slidev's built in slide transitions the preview can play, from its `transitions.css`. */
export const TRANSITIONS = ['fade', 'fade-out', 'slide-left', 'slide-right', 'slide-up', 'slide-down'] as const

export type TransitionName = typeof TRANSITIONS[number]

/** Sliding one way plays the opposite way when going back, as in Slidev. */
const PAIRS: Record<string, string> = {
  'slide-left': 'slide-left | slide-right',
  'slide-right': 'slide-right | slide-left',
  'slide-up': 'slide-up | slide-down',
  'slide-down': 'slide-down | slide-up',
}

function known(name: string | undefined): name is TransitionName {
  return (TRANSITIONS as readonly string[]).includes(name ?? '')
}

/**
 * The transition a slide asks for: its own `transition`, else the deck's.
 * Slidev plays the transition of the slide being left when moving forward,
 * and of the slide being entered when moving back, so a present page asks
 * this about the slide that comes first of the two.
 */
export function slideTransition(frontmatter: Record<string, unknown>, headmatter: Record<string, unknown>): string {
  const own = frontmatter.transition
  if (typeof own === 'string' && own.trim())
    return own
  return typeof headmatter.transition === 'string' ? headmatter.transition : ''
}

/**
 * The CSS transition to play for a name, or none for `none`, an empty or
 * unknown name. A pair such as `slide-left | slide-right` plays its second
 * half going back.
 */
export function resolveTransition(name: string, back: boolean): TransitionName | undefined {
  const trimmed = name.trim()
  const pair = trimmed.includes('|') ? trimmed : PAIRS[trimmed] ?? trimmed
  const [forward, backward] = pair.split('|').map(part => part.trim())
  const chosen = pair.includes('|') && back ? backward : forward
  return known(chosen) ? chosen : undefined
}
