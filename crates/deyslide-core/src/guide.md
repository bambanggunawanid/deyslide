# Writing Deyslide decks

## Workflow

1. Find or make the deck: list_decks, create_project, create_deck.
2. Read it with read_deck. Each slide comes wrapped in <slide number="N">.
3. Change it. edit_slides takes a batch of replace, insert, delete and move edits and saves all of them or none. write_deck replaces the whole deck, which suits a first draft.
4. Look at it with render_slides. Each image shows the slide at its last click step unless you ask for another step. The result also says how many clicks a slide has, whether its content overflows and any render error.
5. Fix what you see and render again. Stop when every slide renders without errors or overflow.
6. Share the editor link from the result, so the person can present or keep editing.

## Good slides

- One idea per slide. A heading and at most about six short lines.
- Prefer a picture, a diagram, code or a component over a paragraph.
- Use a cover layout for the first slide and an end or center layout for the last.
- Reveal points one click at a time when you want the audience to follow along.
- Put what the speaker says in speaker notes, not on the slide.
- Keep the deck's colors and fonts in the first slide's frontmatter so every slide matches.

# Slidev Markdown

A slide's text is optional frontmatter, then Markdown and HTML, then optional speaker notes:

---
layout: two-cols
---

# Title

Content

::right::

Right column content

<!--
Speaker notes
-->

Rules:
- Never put a line with only --- inside a slide's text except around its frontmatter. Slidev reads it as the start of a new slide.
- The first slide's frontmatter is also the deck's headmatter (theme, title, fonts, transition). Keep those keys on slide 1, even when you change its layout or content.
- Layouts: default, cover, center, intro, section, statement, fact, quote, two-cols (split with ::right::), two-cols-header (::left:: and ::right:: after the header), image-right and image-left (with image: in frontmatter), end.
- Reveal list items one per click by wrapping the list in <v-clicks> with blank lines around the list. Reveal one element with <div v-click>...</div>.
- Code blocks use fenced code with a language. Magic Move morphs code between clicks: an outer fence of four backticks with `md magic-move`, holding one three backtick block per step.
- Style with UnoCSS utility classes (Tailwind names), for example class="grid grid-cols-2 gap-4 text-sm". Deyslide adds dey-chip, dey-title and text-dey-muted.
- Speaker notes are an HTML comment at the end of the slide. Put [click] at the start of a note line to show it at that click.
- Keep slides short: a heading and at most about six lines or bullets. Split longer content across slides.

Deyslide components (use them only when they fit the talk):
- <DeyslideScene3D scene-id="name" :camera-position="[8, 6, -7]" focus="node" :zoom-level="1.2" /> shows an interactive 3D scene. Give it a sized parent, such as <div class="h-[420px]">.
- <DeyslideAlgoPlayer src="/animations/bubble-sort.js" /> plays a Motion Canvas animation. Only /animations/bubble-sort.js exists.
- <DeyslideLiveSandbox title="Controls" :initial="{ zoom: 1 }"> with a <template #default="{ state }"> slot gives the audience live controls.
- Bound attributes (starting with :) must hold JSON or a simple expression such as [1, 2][$clicks].

Do not add <script> tags, iframes or links to outside sites unless the person asks for them.

## Deyslide on this computer

This server is Deyslide on this computer. It works on decks saved as Markdown files in the person's Deyslide library folder instead of decks in an account.

- Each project is a folder in the library, and each deck is a .md file inside a project folder. list_decks shows where every file is.
- These decks have no editor links and nobody else can see them. When you finish, give the person the file path and tell them they can open it in the Deyslide app.
- People may work on a deck in the app or in another editor at the same time as you. write_deck and edit_slides refuse to save over a file that no longer holds what you last read or wrote. Call read_deck before your first edit, and again whenever a tool answers that the deck changed on disk.
- render_slides draws slides in the Deyslide app. It opens the app when it is closed, and the app's window must stay open while it draws. When no app answers, your changes are still saved: check the Markdown with read_deck instead.
- Frontmatter YAML is checked like Slidev reads it, with a few rare exceptions this server refuses: nesting deeper than 128 levels, a key left empty, and a tab inside a line's indentation. Write those parts more plainly.
