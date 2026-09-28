import type { Deck } from '../../packages/deck-model/src'

/** A deck that uses every element type, for round trip and sync scenarios. */
export function sampleDeck(): Deck {
  return {
    version: 1,
    slides: [
      {
        id: 'intro',
        frontmatter: { theme: 'default', title: 'Intro to Graphs', layout: 'cover' },
        elements: [
          { id: 'title', type: 'text', pos: { x: 120, y: 80, w: 600, h: null, rotate: 0 }, markdown: '# Intro to Graphs' },
          { id: 'db-scene', type: 'scene3d', pos: { x: 560, y: 160, w: 380, h: 300, rotate: 0 }, props: { focus: 'database', zoomLevel: 1.5, cameraPosition: [8, 6, -7] } },
        ],
        notes: 'Welcome everyone.',
      },
      {
        id: 'details',
        frontmatter: { layout: 'default' },
        elements: [
          { id: 'logo', type: 'image', pos: { x: 20, y: 20, w: 120, h: 60, rotate: 0 }, src: 'https://deyslide.bambanggunawan.id/logo.png', alt: 'Deyslide "logo"' },
          { id: 'box', type: 'shape', pos: { x: 200, y: 300, w: 100, h: 100, rotate: 15 }, props: { shape: 'ellipse', fill: '#f472b6' } },
          { id: 'code', type: 'code', pos: { x: 40, y: 120, w: 500, h: null, rotate: 0 }, steps: [
            { lang: 'ts', code: 'let total = 0' },
            { lang: 'ts', code: 'const total = sum(prices)\n// uses ``` inside' },
          ] },
          { id: 'player', type: 'algo-player', pos: { x: 560, y: 120, w: 380, h: null, rotate: 0 }, props: { src: '/animations/bubble-sort.js', loop: false } },
          { id: 'sandbox', type: 'sandbox', pos: { x: 40, y: 400, w: 600, h: null, rotate: 0 }, props: { initial: { debug: false, zoom: 1, question: 'It\'s "fine" & <ok>' }, step: 0.5 } },
        ],
      },
    ],
  }
}
