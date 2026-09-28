const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
]

/** "3 minutes ago", "yesterday", or "just now" for anything under a minute. */
export function timeAgo(timestamp: number, now = Date.now()) {
  const elapsed = now - timestamp
  for (const [unit, size] of STEPS) {
    if (elapsed >= size)
      return relative.format(-Math.floor(elapsed / size), unit)
  }
  return 'just now'
}

export function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}
