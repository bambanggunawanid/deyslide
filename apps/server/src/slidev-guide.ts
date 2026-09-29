/**
 * How to write Deyslide slides, shared by the deck assistant's instructions
 * and the MCP server's guide, so both teach the same syntax.
 */
export const SLIDEV_GUIDE = `# Slidev Markdown

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
- Code blocks use fenced code with a language. Magic Move morphs code between clicks: an outer fence of four backticks with \`md magic-move\`, holding one three backtick block per step.
- Style with UnoCSS utility classes (Tailwind names), for example class="grid grid-cols-2 gap-4 text-sm". Deyslide adds dey-chip, dey-title and text-dey-muted.
- Speaker notes are an HTML comment at the end of the slide. Put [click] at the start of a note line to show it at that click.
- Keep slides short: a heading and at most about six lines or bullets. Split longer content across slides.

Deyslide components (use them only when they fit the talk):
- <DeyslideScene3D scene-id="name" :camera-position="[8, 6, -7]" focus="node" :zoom-level="1.2" /> shows an interactive 3D scene. Give it a sized parent, such as <div class="h-[420px]">.
- <DeyslideAlgoPlayer src="/animations/bubble-sort.js" /> plays a Motion Canvas animation. Only /animations/bubble-sort.js exists.
- <DeyslideLiveSandbox title="Controls" :initial="{ zoom: 1 }"> with a <template #default="{ state }"> slot gives the audience live controls.
- Bound attributes (starting with :) must hold JSON or a simple expression such as [1, 2][$clicks].`
