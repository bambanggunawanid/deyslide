import { frontmatterErrors, fromMarkdown, joinSlides, slideTexts } from '@deyslide/deck-model'

/** A deck the assistant can hold. Larger Markdown is refused before any model call. */
export const MARKDOWN_MAX_LENGTH = 100_000

/** A change the assistant asked for that would break the deck. The message goes back to the model. */
export class EditError extends Error {}

/** A slide number in words the model and the chat both use: 1 is the first slide. */
function checkNumber(number: number, count: number, label = 'slide') {
  if (!Number.isInteger(number) || number < 1 || number > count)
    throw new EditError(`There is no ${label} ${number}. The deck has ${count} slides.`)
}

/** The first heading of a slide, or its first line, so outlines stay short. */
function titleOf(text: string) {
  const lines = text.split('\n').map(line => line.trim())
  const body = lines[0] === '---' ? lines.slice(lines.indexOf('---', 1) + 1) : lines
  const heading = body.find(line => /^#{1,6}\s/.test(line))
  const first = heading ?? body.find(line => line && !line.startsWith('<!--')) ?? ''
  return first.replace(/^#{1,6}\s+/, '').slice(0, 80) || '(empty)'
}

/**
 * The open deck as a list of slide texts, changed one slide at a time.
 * Every change must leave a deck that Deyslide can read, or it is undone.
 */
export class DeckDraft {
  private slides: string[]

  constructor(markdown: string) {
    this.slides = slideTexts(markdown)
  }

  get markdown() {
    return joinSlides(this.slides)
  }

  get count() {
    return this.slides.length
  }

  /** Numbered slide titles, for tool results. */
  outline() {
    return this.slides.map((text, index) => `${index + 1}. ${titleOf(text)}`).join('\n')
  }

  /** The deck with each slide marked by its number, for the first message. */
  numbered() {
    return this.slides.map((text, index) => `<slide number="${index + 1}">\n${text.trim()}\n</slide>`).join('\n\n')
  }

  replace(number: number, text: string) {
    checkNumber(number, this.count)
    this.change((slides) => {
      slides[number - 1] = this.single(text)
    })
  }

  insert(position: number, text: string) {
    checkNumber(position, this.count + 1, 'position')
    this.change((slides) => {
      slides.splice(position - 1, 0, this.single(text))
    })
  }

  remove(number: number) {
    checkNumber(number, this.count)
    if (this.count === 1)
      throw new EditError('A deck needs at least one slide. Replace the last slide instead.')
    this.change((slides) => {
      slides.splice(number - 1, 1)
    })
  }

  move(from: number, to: number) {
    checkNumber(from, this.count)
    checkNumber(to, this.count, 'position')
    this.change((slides) => {
      const [slide] = slides.splice(from - 1, 1)
      slides.splice(to - 1, 0, slide)
    })
  }

  /** Normalizes one slide's text and refuses text that Slidev would read as several slides. */
  private single(text: string) {
    const trimmed = text.trim()
    const slides = slideTexts(trimmed)
    if (slides.length !== 1)
      throw new EditError(`That text makes ${slides.length} slides. Send one slide per call, without a --- separator between slides.`)
    const [problem] = frontmatterErrors(trimmed)
    if (problem)
      throw new EditError(`The frontmatter is not valid YAML: ${problem.replace(/^Slide 1: /, '')}`)
    return `${trimmed}\n`
  }

  private change(edit: (slides: string[]) => void) {
    const next = [...this.slides]
    edit(next)
    const markdown = joinSlides(next)
    if (markdown.length > MARKDOWN_MAX_LENGTH)
      throw new EditError(`The deck would be longer than ${MARKDOWN_MAX_LENGTH} characters.`)
    try {
      fromMarkdown(markdown)
    }
    catch {
      throw new EditError('That change makes a deck Deyslide cannot read.')
    }
    this.slides = next
  }
}
