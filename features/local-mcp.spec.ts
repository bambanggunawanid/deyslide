// @vitest-environment node
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { BridgeCall } from './support/local-mcp'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { joinSlides, slideTexts, splitSlides } from '../packages/deck-model/src'
import { CORE_SOURCE, cloudSurface, deviceAppendix, deviceFiles } from '../scripts/guide-sync'
import { demoDeckMarkdown } from './support/deck-content'
import { connectLocalMcp, endedProcessId, FakeRenderBridge, leaveStaleBridge, PIXEL, TempFolders } from './support/local-mcp'

const feature = await loadFeature('./local-mcp.feature')

/** Tools whose descriptions say "file path" where the hosted ones say "editor link". */
const FILE_PATH_TOOLS = ['create_deck', 'read_deck']
/**
 * The hosted list_decks description that the local one was written
 * against, and the local one, as in crates/deyslide-core/src/mcp.rs. When
 * the hosted text changes, update both here and there.
 */
const HOSTED_LIST_DECKS = 'Lists the person\'s projects and the decks in each, then projects and decks other people shared with them and the role they have. Includes deck ids, slide counts and editor links.'
const LOCAL_LIST_DECKS = 'Lists the projects in the Deyslide library folder on this computer and the decks in each. Includes deck ids, slide counts and file paths. Decks on this computer are not shared with anyone.'
/**
 * The same for write_deck: the hosted server merges a write with what
 * people changed since Claude read the deck, while this one saves nothing
 * over a file Claude has not read.
 */
const HOSTED_WRITE_DECK = 'Replaces all of a deck\'s Markdown. Use it for a first draft or a full rewrite; edit_slides is safer for a few slides. Call read_deck first: edits people make while you work are then kept. Writing a deck you have not read overwrites them. The first slide\'s frontmatter holds the deck settings.'
const LOCAL_WRITE_DECK = 'Replaces all of a deck\'s Markdown. Use it for a first draft or a full rewrite; edit_slides is safer for a few slides. Call read_deck first: write_deck saves nothing until you have read the deck, and nothing over a file that changed on disk since you last read or wrote it. The first slide\'s frontmatter holds the deck settings.'
/** Tools with a description of their own on this computer. */
const OWN_DESCRIPTIONS = ['list_decks', 'write_deck']

const NOT_FOUND = 'There is no deck with that id in this library. Call list_decks to see the decks.'
const NO_PROJECT = 'There is no project with that id in this library. Call list_decks, or create_project first.'
const NO_APP = 'Open the Deyslide app to see slide images. The deck is saved.'
const RECURSION = '---\nlayout: cover\n---\n\n# Recursion\n\n---\n\n# Base case\n\n---\n\n# Recursive case\n'
const CLAUDE_DECK = '---\ntitle: Sorting\nlayout: cover\n---\n\n# Sorting, again\n\n---\n\n# Merge sort\n'
const OTHER_EDITOR = '\n---\n\n# Added in another editor\n'
const CHANGED_ON_DISK = 'Nothing was saved. The deck changed on disk since you last read or wrote it. Call read_deck again, then make your change.'
const NOT_READ = 'Nothing was saved. Call read_deck first, then make your change.'

/** The first 16 hex characters of a name's SHA-256, as library ids use them. */
const shortHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

interface ListedDeck { id: string, name: string, slideCount: number, path: string }
interface Listed { library: string, projects: { id: string, name: string, path: string, decks: ListedDeck[] }[] }

describeFeature(feature, ({ Background, Scenario, ScenarioOutline, AfterEachScenario }) => {
  let folders: TempFolders
  let claude: Client
  let bridge: FakeRenderBridge | undefined
  let result: CallToolResult

  AfterEachScenario(async () => {
    await claude?.close()
    await bridge?.close()
    bridge = undefined
    folders?.remove()
  })

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    result = await claude.callTool({ name, arguments: args }) as CallToolResult
    return result
  }
  const resultText = () => result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n')
  const listed = async () => (await claude.callTool({ name: 'list_decks', arguments: {} })).structuredContent as unknown as Listed
  const projectIdOf = async (name: string) => (await listed()).projects.find(project => project.name === name)!.id
  const deckIdOf = async (name: string) => (await listed()).projects.flatMap(project => project.decks).find(deck => deck.name === name)!.id
  const sorting = () => folders.read('Talks/Sorting.md')
  const run = (args: string[] = ['--library', folders.library, '--data-dir', folders.data]) => connectLocalMcp(args)

  Background(({ Given, And }) => {
    Given('an empty Deyslide library and data folder', () => {
      folders = new TempFolders()
    })
    And('Claude Code runs deyslide-mcp on them', async () => {
      claude = await run()
    })
  })

  Scenario('The tools match the hosted server', ({ Then, And }) => {
    let cloud: Awaited<ReturnType<typeof cloudSurface>>
    let tools: Awaited<ReturnType<Client['listTools']>>['tools']
    const hosted = (name: string) => cloud.tools.find(tool => tool.name === name)!.description!
    const local = (name: string) => tools.find(tool => tool.name === name)!.description!
    Then('the server calls itself "deyslide-local" with the title "Deyslide (this computer)"', () => {
      expect(claude.getServerVersion()).toMatchObject({ name: 'deyslide-local', title: 'Deyslide (this computer)' })
    })
    And('it offers the hosted server\'s tools with the same titles, annotations and input schemas', async () => {
      cloud = await cloudSurface()
      tools = (await claude.listTools()).tools
      expect(tools.map(tool => tool.name)).toEqual(cloud.tools.map(tool => tool.name))
      for (const [index, tool] of tools.entries()) {
        const hosted = cloud.tools[index]
        expect(tool.title, tool.name).toBe(hosted.title)
        expect(tool.annotations, tool.name).toEqual(hosted.annotations)
        expect(normalized(tool.inputSchema), tool.name).toEqual(normalized(hosted.inputSchema))
      }
    })
    And('create_deck and read_deck have the hosted descriptions with "file path" in place of "editor link"', () => {
      for (const name of FILE_PATH_TOOLS) {
        expect(hosted(name).split('editor link'), `${name} should name the editor link once`).toHaveLength(2)
        expect(local(name), name).toBe(hosted(name).replace('editor link', 'file path'))
      }
    })
    And('list_decks describes the library folder, written against today\'s hosted description', () => {
      expect(hosted('list_decks'), 'The hosted list_decks changed: update LOCAL_LIST_DECKS and HOSTED_LIST_DECKS here and in mcp.rs').toBe(HOSTED_LIST_DECKS)
      expect(local('list_decks')).toBe(LOCAL_LIST_DECKS)
    })
    And('write_deck says a read comes first, written against today\'s hosted description', () => {
      expect(hosted('write_deck'), 'The hosted write_deck changed: update LOCAL_WRITE_DECK and HOSTED_WRITE_DECK here and in mcp.rs').toBe(HOSTED_WRITE_DECK)
      expect(local('write_deck')).toBe(LOCAL_WRITE_DECK)
    })
    And('every other tool has the hosted description', () => {
      for (const tool of tools.filter(tool => !OWN_DESCRIPTIONS.includes(tool.name) && !FILE_PATH_TOOLS.includes(tool.name)))
        expect(tool.description, tool.name).toBe(hosted(tool.name))
    })
  })

  Scenario('The guide and instructions add a part about this computer', ({ Then, And }) => {
    let cloud: Awaited<ReturnType<typeof cloudSurface>>
    Then('get_guide returns the hosted guide followed by the device appendix', async () => {
      cloud = await cloudSurface()
      await call('get_guide')
      expect(resultText()).toBe(`${cloud.guide}\n\n${deviceAppendix()}`)
    })
    And('the server\'s instructions are the hosted instructions followed by the device appendix', () => {
      expect(claude.getInstructions()).toBe(`${cloud.instructions}\n\n${deviceAppendix()}`)
    })
    And('the copies in the Rust crate are what pnpm guide:sync writes today', () => {
      for (const [name, content] of Object.entries(deviceFiles(cloud)))
        expect(readFileSync(new URL(name, CORE_SOURCE), 'utf8'), `${name} is out of date: run pnpm guide:sync`).toBe(content)
    })
  })

  Scenario('Create a project and a deck', ({ When, Then, And }) => {
    let deck: ListedDeck
    When('Claude Code creates the project "Lectures" and in it the deck "Recursion" with 3 slides', async () => {
      await call('create_project', { name: 'Lectures' })
      const project = (result.structuredContent as { project: { id: string } }).project
      expect(project.id).toBe(`local-p-${shortHash('Lectures')}`)
      await call('create_deck', { projectId: project.id, name: 'Recursion', markdown: RECURSION })
      expect(result.isError).toBeFalsy()
      deck = (result.structuredContent as { deck: ListedDeck }).deck
    })
    Then('the file "Lectures/Recursion.md" in the library holds that Markdown', () => {
      expect(folders.read('Lectures/Recursion.md')).toBe(RECURSION)
    })
    And('the answer gives the deck\'s id and file path', () => {
      expect(deck).toEqual({ id: `local-d-${shortHash('Lectures/Recursion.md')}`, name: 'Recursion', slideCount: 3, path: folders.path('Lectures/Recursion.md') })
      expect(resultText()).toContain(`with id ${deck.id} and 3 slides. It is saved at ${deck.path}.`)
      expect(resultText()).toContain('1. Recursion\n2. Base case\n3. Recursive case')
    })
  })

  Scenario('A deck without Markdown starts with a title slide', ({ Given, When, Then }) => {
    Given('the library has the project "Talks"', () => {
      mkdirSync(folders.path('Talks'))
    })
    When('Claude Code creates the deck "Sorting" in "Talks" without Markdown', async () => {
      await call('create_deck', { projectId: await projectIdOf('Talks'), name: 'Sorting' })
      expect(result.isError).toBeFalsy()
    })
    Then('the file "Talks/Sorting.md" holds one cover slide titled "Sorting"', () => {
      expect(sorting()).toBe('---\ntitle: "Sorting"\nlayout: cover\n---\n\n# Sorting\n')
      const slides = splitSlides(sorting())
      expect(slides).toHaveLength(1)
      expect(slides[0].frontmatter).toEqual({ title: 'Sorting', layout: 'cover' })
    })
  })

  Scenario('List decks with their files', ({ Given, And, When, Then }) => {
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    And('the library also holds a hidden folder, a text file and a Markdown file outside any project', () => {
      folders.write('.drafts/Old.md', '# Old')
      folders.write('Talks/notes.txt', 'notes')
      folders.write('Talks/.Sorting.md.swp', 'swap')
      folders.write('Loose.md', '# Loose')
    })
    When('Claude Code lists the decks', async () => {
      await call('list_decks')
    })
    Then('it shows only the deck "Sorting" with 5 slides and the path of its file', () => {
      const path = folders.path('Talks/Sorting.md')
      const id = `local-d-${shortHash('Talks/Sorting.md')}`
      expect(result.structuredContent).toMatchObject({
        library: folders.library,
        projects: [{ id: `local-p-${shortHash('Talks')}`, name: 'Talks', decks: [{ id, name: 'Sorting', slideCount: 5, path }] }],
      })
      expect(resultText()).toBe(`Library: ${folders.library}\nProject "Talks" (id local-p-${shortHash('Talks')})\n  - Deck "Sorting" (id ${id}), 5 slides, ${path}`)
    })
  })

  Scenario('Read a deck with numbered slides', ({ Given, When, Then }) => {
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    When('Claude Code reads the deck "Sorting"', async () => {
      await call('read_deck', { deckId: await deckIdOf('Sorting') })
    })
    Then('it gets 5 slides wrapped in numbered slide tags and the file path', () => {
      expect(resultText().match(/<slide number="\d+">/g)).toEqual([1, 2, 3, 4, 5].map(number => `<slide number="${number}">`))
      expect(resultText()).toContain(`Deck "Sorting" (5 slides) in project "Talks". File: ${folders.path('Talks/Sorting.md')}`)
      expect((result.structuredContent as { markdown: string }).markdown).toBe(demoDeckMarkdown())
    })
  })

  Scenario('Write a whole deck', ({ Given, When, Then }) => {
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    When('Claude Code reads the deck "Sorting" and writes a 2 slide deck in its place', async () => {
      const deckId = await deckIdOf('Sorting')
      await call('read_deck', { deckId })
      await call('write_deck', { deckId, markdown: CLAUDE_DECK })
      expect(result.isError).toBeFalsy()
      expect(resultText()).toBe('Saved. The deck now has these slides:\n1. Sorting, again\n2. Merge sort\n\nCheck them with render_slides.')
    })
    Then('the file holds exactly that deck', () => {
      expect(sorting()).toBe(CLAUDE_DECK)
    })
  })

  Scenario('Edits land in one batch', ({ Given, And, When, Then }) => {
    let deckId: string
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    And('Claude Code read the deck "Sorting"', async () => {
      deckId = await deckIdOf('Sorting')
      await call('read_deck', { deckId })
    })
    When('Claude Code adds a slide "# Summary" at the end and moves it to position 2', async () => {
      await call('edit_slides', { deckId, edits: [{ action: 'insert', position: 6, text: '# Summary' }, { action: 'move', slide: 6, to: 2 }] })
      expect(result.isError).toBeFalsy()
      expect(resultText()).toMatch(/^Saved 2 edits\. The deck now has these slides:\n1\. .+\n2\. Summary\n/)
    })
    Then('the deck has 6 slides and slide 2 is "# Summary"', () => {
      const slides = splitSlides(sorting())
      expect(slides).toHaveLength(6)
      expect(slides[1].content).toBe('# Summary')
    })
  })

  Scenario('A bad edit saves nothing', ({ Given, When, Then, And }) => {
    let deckId: string
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    And('Claude Code read the deck "Sorting"', async () => {
      deckId = await deckIdOf('Sorting')
      await call('read_deck', { deckId })
    })
    When('Claude Code sends two edits where the second breaks the frontmatter', async () => {
      await call('edit_slides', { deckId, edits: [
        { action: 'replace', slide: 1, text: '# Changed' },
        { action: 'replace', slide: 2, text: '---\nlayout: [center\n---\n\n# Broken' },
      ] })
    })
    Then('the answer says "Nothing was saved. Edit 2 (replace) failed: The frontmatter is not valid YAML"', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toContain('Nothing was saved. Edit 2 (replace) failed: The frontmatter is not valid YAML')
    })
    And('the file is unchanged', () => {
      expect(sorting()).toBe(demoDeckMarkdown())
    })
  })

  Scenario('A whole deck that is not valid is refused', ({ Given, When, Then, And }) => {
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    When('Claude Code writes a deck whose first frontmatter is broken', async () => {
      await call('write_deck', { deckId: await deckIdOf('Sorting'), markdown: '---\ntitle: [oops\n---\n\n# Hello\n' })
    })
    Then('the answer starts with "Nothing was saved. The frontmatter is not valid YAML."', () => {
      expect(result.isError).toBe(true)
      expect(resultText().startsWith('Nothing was saved. The frontmatter is not valid YAML. Slide 1: ')).toBe(true)
    })
    And('the file is unchanged', () => {
      expect(sorting()).toBe(demoDeckMarkdown())
    })
  })

  Scenario('A file changed on disk after Claude Code read it is not overwritten', ({ Given, And, When, Then }) => {
    let deckId: string
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    And('Claude Code read the deck "Sorting"', async () => {
      deckId = await deckIdOf('Sorting')
      await call('read_deck', { deckId })
    })
    When('someone saves the file in another editor', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown() + OTHER_EDITOR)
    })
    And('Claude Code writes the whole deck', async () => {
      await call('write_deck', { deckId, markdown: CLAUDE_DECK })
    })
    Then('the answer says "Nothing was saved. The deck changed on disk since you last read or wrote it. Call read_deck again, then make your change."', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe(CHANGED_ON_DISK)
    })
    And('the file keeps the other editor\'s change', () => {
      expect(sorting()).toBe(demoDeckMarkdown() + OTHER_EDITOR)
    })
    When('Claude Code reads the deck again and writes it', async () => {
      await call('read_deck', { deckId })
      expect(resultText()).toContain('Added in another editor')
      await call('write_deck', { deckId, markdown: CLAUDE_DECK })
      expect(result.isError).toBeFalsy()
    })
    Then('the file holds Claude Code\'s deck', () => {
      expect(sorting()).toBe(CLAUDE_DECK)
    })
  })

  Scenario('Slide numbers from before a change on disk are refused', ({ Given, And, When, Then }) => {
    let deckId: string
    let changed: string
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    And('Claude Code read the deck "Sorting"', async () => {
      deckId = await deckIdOf('Sorting')
      await call('read_deck', { deckId })
    })
    When('someone adds a slide after the first one in another editor', () => {
      const texts = slideTexts(demoDeckMarkdown())
      texts.splice(1, 0, '# Agenda\n')
      changed = joinSlides(texts)
      folders.write('Talks/Sorting.md', changed)
    })
    And('Claude Code replaces slide 3, as it read it', async () => {
      await call('edit_slides', { deckId, edits: [{ action: 'replace', slide: 3, text: '# Claude was here' }] })
    })
    Then('the answer says "Nothing was saved. The deck changed on disk since you last read or wrote it. Call read_deck again, then make your change."', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe(CHANGED_ON_DISK)
    })
    And('the file keeps the other editor\'s change', () => {
      expect(sorting()).toBe(changed)
    })
    When('Claude Code reads the deck again and replaces what is now slide 4', async () => {
      await call('read_deck', { deckId })
      expect(resultText()).toContain('<slide number="2">\n# Agenda\n</slide>')
      await call('edit_slides', { deckId, edits: [{ action: 'replace', slide: 4, text: '# Claude was here' }] })
      expect(result.isError).toBeFalsy()
    })
    Then('the other editor\'s slide and the rest of the deck are kept, with Claude Code\'s slide in place of the one it meant', () => {
      const before = splitSlides(demoDeckMarkdown()).map(slide => slide.content)
      expect(splitSlides(sorting()).map(slide => slide.content)).toEqual([before[0], '# Agenda', before[1], '# Claude was here', before[3], before[4]])
    })
  })

  Scenario('A deck Claude Code has not read since the server started is not changed', ({ Given, And, When, Then }) => {
    let deckId: string
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    And('Claude Code read the deck "Sorting"', async () => {
      deckId = await deckIdOf('Sorting')
      await call('read_deck', { deckId })
    })
    When('Claude Code restarts deyslide-mcp and keeps the conversation', async () => {
      await claude.close()
      claude = await run()
    })
    And('someone saves the file in another editor', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown() + OTHER_EDITOR)
    })
    And('Claude Code writes the whole deck', async () => {
      await call('write_deck', { deckId, markdown: CLAUDE_DECK })
    })
    Then('the answer says "Nothing was saved. Call read_deck first, then make your change."', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe(NOT_READ)
    })
    When('Claude Code sends an edit to slide 1', async () => {
      await call('edit_slides', { deckId, edits: [{ action: 'replace', slide: 1, text: '# Claude was here' }] })
    })
    Then('that answer is the same', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe(NOT_READ)
    })
    And('the file keeps the other editor\'s change', () => {
      expect(sorting()).toBe(demoDeckMarkdown() + OTHER_EDITOR)
    })
  })

  Scenario('Claude Code can keep changing a deck it created or wrote', ({ Given, When, And, Then }) => {
    let deckId: string
    let changed: string
    const answers: string[] = []
    Given('the library has the project "Talks"', () => {
      mkdirSync(folders.path('Talks'))
    })
    When('Claude Code creates the deck "Sorting" in "Talks" and writes it again without reading it', async () => {
      await call('create_deck', { projectId: await projectIdOf('Talks'), name: 'Sorting', markdown: RECURSION })
      deckId = (result.structuredContent as { deck: ListedDeck }).deck.id
      await call('write_deck', { deckId, markdown: CLAUDE_DECK })
      answers.push(resultText())
    })
    And('Claude Code writes it once more and then edits slide 1', async () => {
      await call('write_deck', { deckId, markdown: RECURSION })
      answers.push(resultText())
      await call('edit_slides', { deckId, edits: [{ action: 'replace', slide: 1, text: '# Recursion, again' }] })
      answers.push(resultText())
    })
    Then('each answer starts with "Saved"', () => {
      expect(answers.map(answer => answer.split(' ')[0])).toEqual(['Saved.', 'Saved.', 'Saved'])
      expect(splitSlides(sorting()).map(slide => slide.content)).toEqual(['# Recursion, again', '# Base case', '# Recursive case'])
    })
    When('someone saves the file in another editor', () => {
      changed = sorting() + OTHER_EDITOR
      folders.write('Talks/Sorting.md', changed)
    })
    And('Claude Code writes the whole deck', async () => {
      await call('write_deck', { deckId, markdown: CLAUDE_DECK })
    })
    Then('the answer says "Nothing was saved. The deck changed on disk since you last read or wrote it. Call read_deck again, then make your change."', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe(CHANGED_ON_DISK)
    })
    And('the file keeps the other editor\'s change', () => {
      expect(sorting()).toBe(changed)
    })
  })

  Scenario('Saving follows a link inside the library and keeps the file\'s permissions', ({ Given, When, Then, And }) => {
    // Windows lets only administrators make links and has no owner only mode, so the checks run on macOS and Linux.
    const unix = process.platform !== 'win32'
    const deckId = `local-d-${shortHash('Talks/Intro.md')}`
    Given('the project "Talks" has a deck "Intro" that links to "Shared/Intro.md", a file only its owner can read', () => {
      folders.write('Shared/Intro.md', '# Intro\n')
      chmodSync(folders.path('Shared/Intro.md'), 0o600)
      mkdirSync(folders.path('Talks'))
      if (unix)
        symlinkSync('../Shared/Intro.md', folders.path('Talks/Intro.md'))
      else
        folders.write('Talks/Intro.md', '# Intro\n')
    })
    When('Claude Code reads the deck "Intro" and writes it', async () => {
      await call('read_deck', { deckId })
      await call('write_deck', { deckId, markdown: CLAUDE_DECK })
      expect(result.isError).toBeFalsy()
    })
    Then('"Talks/Intro.md" is still a link and "Shared/Intro.md" holds Claude Code\'s deck', () => {
      expect(folders.read('Talks/Intro.md')).toBe(CLAUDE_DECK)
      if (unix) {
        expect(lstatSync(folders.path('Talks/Intro.md')).isSymbolicLink()).toBe(true)
        expect(folders.read('Shared/Intro.md')).toBe(CLAUDE_DECK)
      }
    })
    And('only its owner can still read "Shared/Intro.md"', () => {
      if (unix)
        expect(statSync(folders.path('Shared/Intro.md')).mode & 0o777).toBe(0o600)
    })
  })

  Scenario('A read-only deck is left alone', ({ Given, And, When, Then }) => {
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    And('the file "Talks/Sorting.md" is read-only', () => {
      chmodSync(folders.path('Talks/Sorting.md'), 0o444)
    })
    When('Claude Code reads the deck "Sorting" and writes it', async () => {
      const deckId = await deckIdOf('Sorting')
      await call('read_deck', { deckId })
      await call('write_deck', { deckId, markdown: CLAUDE_DECK })
    })
    Then('the answer says "Nothing was saved. The deck file is read-only. Make it writable first."', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe('Nothing was saved. The deck file is read-only. Make it writable first.')
    })
    And('the file is unchanged', () => {
      expect(sorting()).toBe(demoDeckMarkdown())
      expect(statSync(folders.path('Talks/Sorting.md')).mode & 0o222).toBe(0)
      chmodSync(folders.path('Talks/Sorting.md'), 0o644)
    })
  })

  Scenario('Ids that point outside the library are not found', ({ Given, And, When, Then }) => {
    const answers: { tool: string, id: string, error?: boolean, text: string }[] = []
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    And('a Markdown file sits next to the library, outside it', () => {
      writeFileSync(join(folders.root, 'secret.md'), '# Secret\n')
    })
    When('Claude Code calls every deck tool with ids made from paths', async () => {
      const ids = [
        'local-d-../secret.md',
        '../secret.md',
        join(folders.root, 'secret.md'),
        `local-d-${Buffer.from('../secret.md').toString('base64url')}`,
        `local-d-${shortHash('../secret.md')}`,
        `local-d-${shortHash('Talks/../../secret.md')}`,
        'local-d-0000000000000000',
        `local-p-${shortHash('Talks')}`,
      ]
      for (const id of ids) {
        for (const [tool, args] of [
          ['read_deck', {}],
          ['write_deck', { markdown: '# Hacked\n' }],
          ['edit_slides', { edits: [{ action: 'replace', slide: 1, text: '# Hacked' }] }],
          ['render_slides', { slides: [1] }],
        ] as const) {
          await call(tool, { deckId: id, ...args })
          answers.push({ tool, id, error: result.isError, text: resultText() })
        }
      }
    })
    Then('each answer says "There is no deck with that id in this library. Call list_decks to see the decks."', () => {
      for (const answer of answers)
        expect(answer, `${answer.tool} ${answer.id}`).toEqual({ ...answer, error: true, text: NOT_FOUND })
    })
    And('creating a deck in a project id made from a path says "There is no project with that id in this library. Call list_decks, or create_project first."', async () => {
      for (const projectId of ['local-p-..', '..', folders.root, `local-p-${shortHash('..')}`]) {
        await call('create_deck', { projectId, name: 'Escape', markdown: '# Hacked\n' })
        expect(result.isError, projectId).toBe(true)
        expect(resultText(), projectId).toBe(NO_PROJECT)
      }
      expect(existsSync(join(folders.root, 'Escape.md'))).toBe(false)
    })
    And('the file outside the library is unchanged', () => {
      expect(readFileSync(join(folders.root, 'secret.md'), 'utf8')).toBe('# Secret\n')
      expect(sorting()).toBe(demoDeckMarkdown())
    })
  })

  Scenario('Links cannot reach files outside the library', ({ Given, And, When, Then }) => {
    Given('a Markdown file sits next to the library, outside it', () => {
      writeFileSync(join(folders.root, 'secret.md'), '# Secret\n')
      mkdirSync(join(folders.root, 'elsewhere'))
      writeFileSync(join(folders.root, 'elsewhere', 'Secret.md'), '# Secret\n')
    })
    And('the library has a project folder and a deck file that link outside it', () => {
      mkdirSync(folders.path('Talks'))
      // Windows lets only administrators make links, so this part runs on macOS and Linux.
      if (process.platform !== 'win32') {
        symlinkSync(join(folders.root, 'elsewhere'), folders.path('Linked'))
        symlinkSync(join(folders.root, 'secret.md'), folders.path('Talks/Secret.md'))
      }
    })
    When('Claude Code lists the decks', async () => {
      await call('list_decks')
    })
    Then('the linked folder and file are not listed', async () => {
      expect((result.structuredContent as unknown as Listed).projects).toEqual([
        { id: `local-p-${shortHash('Talks')}`, name: 'Talks', path: folders.path('Talks'), decks: [] },
      ])
      for (const id of [`local-d-${shortHash('Talks/Secret.md')}`, `local-d-${shortHash('Linked/Secret.md')}`]) {
        await call('read_deck', { deckId: id })
        expect(resultText()).toBe(NOT_FOUND)
      }
    })
  })

  ScenarioOutline('Names that do not work on every system are refused', ({ When, Then, And }, variables) => {
    When('Claude Code creates the project "<name>"', async () => {
      await call('create_project', { name: variables.name === '81 letters' ? 'a'.repeat(81) : variables.name })
    })
    Then('the answer contains "<problem>"', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toContain(variables.problem)
    })
    And('the library still has no folders', () => {
      expect(readdirSync(folders.library)).toEqual([])
    })
  })

  Scenario('A deck named after a Windows device is refused', ({ Given, When, Then, And }) => {
    Given('the library has the project "Talks"', () => {
      mkdirSync(folders.path('Talks'))
    })
    When('Claude Code creates the deck "aux" in "Talks"', async () => {
      await call('create_deck', { projectId: await projectIdOf('Talks'), name: 'aux', markdown: '# Aux\n' })
    })
    Then('the answer says "aux" is a name Windows keeps for itself', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe('"aux" is a name Windows keeps for itself. Pick another name')
    })
    And('the folder "Talks" holds no files', () => {
      expect(readdirSync(folders.path('Talks'))).toEqual([])
    })
  })

  Scenario('A taken name is refused', ({ Given, When, Then }) => {
    Given('the library has the project "Talks"', () => {
      mkdirSync(folders.path('Talks'))
    })
    When('Claude Code creates the project "talks"', async () => {
      await call('create_project', { name: 'talks' })
    })
    Then('the answer says there is already a project named "talks"', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe('There is already a project named "talks"')
      expect(readdirSync(folders.library)).toEqual(['Talks'])
    })
  })

  Scenario('See slides as images through the app', ({ Given, And, When, Then }) => {
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    And('the Deyslide app is open and reports that slide 3 overflows', async () => {
      bridge = new FakeRenderBridge()
      bridge.overflowing.add('# Spatial zoom')
      await bridge.open(folders.data)
    })
    When('Claude Code renders slides 1 and 3 of "Sorting"', async () => {
      await call('render_slides', { deckId: await deckIdOf('Sorting'), slides: [1, 3] })
    })
    Then('it gets two PNG images with each slide\'s click count', () => {
      const images = result.content.filter(item => item.type === 'image')
      expect(images).toHaveLength(2)
      expect(images.every(image => image.type === 'image' && image.mimeType === 'image/png' && image.data === PIXEL)).toBe(true)
      expect(resultText()).toContain('Slide 1: 2 clicks, fits the slide.')
      expect(resultText()).toContain(`File: ${folders.path('Talks/Sorting.md')}`)
    })
    And('slide 3 is reported as overflowing', () => {
      expect(resultText()).toContain('Slide 3: 2 clicks, content overflows the slide: shorten it or split it.')
      expect(result.structuredContent).toEqual({ slides: [
        { number: 1, clicks: 2, overflow: false, error: null },
        { number: 3, clicks: 2, overflow: true, error: null },
      ] })
    })
    And('the app was asked, with its token, for slides 1 and 3 of the file at their last click', () => {
      expect(bridge!.calls).toEqual([{
        authorization: `Bearer ${bridge!.token}`,
        body: { markdown: demoDeckMarkdown(), slides: [{ number: 1, clicks: 'last' }, { number: 3, clicks: 'last' }] },
      } satisfies BridgeCall])
    })
  })

  Scenario('See a slide before its clicks or at one step', ({ Given, And, When, Then }) => {
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    And('the Deyslide app is open', async () => {
      bridge = new FakeRenderBridge()
      await bridge.open(folders.data)
    })
    When('Claude Code renders slide 2 of "Sorting" before its first click, then slides 2 and 3 at step 2', async () => {
      const deckId = await deckIdOf('Sorting')
      await call('render_slides', { deckId, slides: [2], click: 'first' })
      expect(result.isError).toBeFalsy()
      await call('render_slides', { deckId, slides: [2, 3], click: 2 })
      expect(result.isError).toBeFalsy()
    })
    Then('the app was asked for slide 2 with clicks set to 0, then for slides 2 and 3 with 2', () => {
      expect(bridge!.calls.map(call => call.body.slides)).toEqual([
        [{ number: 2, clicks: 0 }],
        [{ number: 2, clicks: 2 }, { number: 3, clicks: 2 }],
      ])
    })
  })

  Scenario('Without slide numbers the first six slides are drawn', ({ Given, And, When, Then }) => {
    Given('the library has a deck "Long" in the project "Talks" with 8 slides', () => {
      folders.write('Talks/Long.md', joinSlides(Array.from({ length: 8 }, (_, index) => `# Slide ${index + 1}\n`)))
    })
    And('the Deyslide app is open', async () => {
      bridge = new FakeRenderBridge()
      await bridge.open(folders.data)
    })
    When('Claude Code renders "Long" without naming slides', async () => {
      await call('render_slides', { deckId: await deckIdOf('Long') })
      expect(result.isError).toBeFalsy()
    })
    Then('the app was asked for slides 1 to 6 at their last click', () => {
      expect(bridge!.calls.map(call => call.body.slides)).toEqual([[1, 2, 3, 4, 5, 6].map(number => ({ number, clicks: 'last' }))])
      expect(result.content.filter(item => item.type === 'image')).toHaveLength(6)
    })
    And('the answer ends with "The deck has 8 slides. Ask for the others by number."', () => {
      expect(resultText().endsWith(`File: ${folders.path('Talks/Long.md')}\n\nThe deck has 8 slides. Ask for the others by number.`)).toBe(true)
    })
  })

  Scenario('No app, no images', ({ Given, And, When, Then }) => {
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    And('the Deyslide app is not open', () => {
      expect(existsSync(join(folders.data, 'render-bridge.json'))).toBe(false)
    })
    When('Claude Code renders slides 1 and 3 of "Sorting"', async () => {
      await call('render_slides', { deckId: await deckIdOf('Sorting'), slides: [1, 3] })
    })
    Then('the answer says "Open the Deyslide app to see slide images. The deck is saved."', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe(NO_APP)
    })
  })

  Scenario('An app that quit leaves no images either', ({ Given, And, When, Then }) => {
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    And('the Deyslide app quit and left its bridge file behind', async () => {
      await leaveStaleBridge(folders.data)
    })
    When('Claude Code renders slides 1 and 3 of "Sorting"', async () => {
      await call('render_slides', { deckId: await deckIdOf('Sorting'), slides: [1, 3] })
    })
    Then('the answer says "Open the Deyslide app to see slide images. The deck is saved."', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe(NO_APP)
    })
  })

  Scenario('A bridge file left by an app that quit is never contacted', ({ Given, And, When, Then }) => {
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    And('the Deyslide app quit and another program now listens on the port its bridge file names', async () => {
      bridge = new FakeRenderBridge()
      await bridge.open(folders.data, endedProcessId())
    })
    When('Claude Code renders slides 1 and 3 of "Sorting"', async () => {
      await call('render_slides', { deckId: await deckIdOf('Sorting'), slides: [1, 3] })
    })
    Then('the answer says "Open the Deyslide app to see slide images. The deck is saved."', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe(NO_APP)
    })
    And('the other program received nothing', () => {
      expect(bridge!.calls).toEqual([])
    })
  })

  Scenario('Slides past the end are refused', ({ Given, When, Then }) => {
    Given('the library has the demo deck "Sorting" in the project "Talks"', () => {
      folders.write('Talks/Sorting.md', demoDeckMarkdown())
    })
    When('Claude Code renders slide 9 of "Sorting"', async () => {
      await call('render_slides', { deckId: await deckIdOf('Sorting'), slides: [9] })
    })
    Then('the answer says "The deck has 5 slides, so there is no slide 9."', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe('The deck has 5 slides, so there is no slide 9.')
    })
  })

  Scenario('The library comes from the app\'s settings', ({ Given, And, When, Then }) => {
    const chosen = () => join(folders.root, 'chosen')
    const empty = () => join(folders.root, 'empty')
    const saveSettings = (libraryRoot: string) =>
      writeFileSync(join(folders.data, 'settings.json'), JSON.stringify({ libraryRoot, serverUrl: 'https://deyslide.example' }))
    Given('the app\'s settings point to a library folder holding the demo deck "Sorting" in the project "Talks"', () => {
      mkdirSync(join(chosen(), 'Talks'), { recursive: true })
      writeFileSync(join(chosen(), 'Talks', 'Sorting.md'), demoDeckMarkdown())
      saveSettings(chosen())
    })
    And('Claude Code runs deyslide-mcp without a library folder', async () => {
      await claude.close()
      claude = await run(['--data-dir', folders.data])
    })
    When('Claude Code lists the decks', async () => {
      await call('list_decks')
    })
    Then('it shows the deck "Sorting" in that folder', () => {
      const shown = result.structuredContent as unknown as Listed
      expect(shown.library).toBe(chosen())
      expect(shown.projects[0].decks[0]).toMatchObject({ name: 'Sorting', path: join(chosen(), 'Talks', 'Sorting.md') })
    })
    When('the app\'s settings point to another, empty library folder', () => {
      saveSettings(empty())
    })
    And('Claude Code lists the decks again', async () => {
      await call('list_decks')
    })
    Then('it says that library has no projects yet', () => {
      expect(resultText()).toBe(`The library at ${empty()} has no projects yet. Create one with create_project.`)
      expect(existsSync(empty())).toBe(true)
    })
  })
})

/** A schema without the draft marker, so only what it allows is compared. */
function normalized(schema: Record<string, unknown>) {
  const { $schema: _draft, ...rest } = schema
  return JSON.parse(JSON.stringify(rest)) as unknown
}
