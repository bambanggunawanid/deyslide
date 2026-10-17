import type { Bounds, Box, Guide, Point, View } from '../apps/web/src/canvas/geometry'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import {
  clampView,
  corners,
  fitView,
  hitTest,
  keepOnSlide,
  normalizeAngle,
  pinchView,
  resizeBox,
  rotateHandlePlace,
  rotationFor,
  snapMove,
  snapResize,
  toCanvas,
  zoomAt,
} from '../apps/web/src/canvas/geometry'

const feature = await loadFeature('./canvas-geometry.feature')

const STAGE = { width: 980, height: 551.25 }

function expectBox(box: Box, expected: Partial<Box>) {
  for (const [key, value] of Object.entries(expected))
    expect(box[key as keyof Box], key).toBeCloseTo(value as number, 6)
}

describeFeature(feature, ({ Scenario }) => {
  Scenario('A point hits a turned box only inside it', ({ Given, Then, And }) => {
    let box: Box
    Given('a box at 100, 100 of 200 by 100, turned 45 degrees', () => {
      box = { x: 100, y: 100, w: 200, h: 100, rotate: 45 }
    })
    Then('the point 200, 150 hits the box', () => {
      expect(hitTest([{ id: 'turned', box }], { x: 200, y: 150 })).toBe('turned')
    })
    And('the point 290, 105 misses it, though it is inside the box before turning', () => {
      expect(hitTest([{ id: 'turned', box: { ...box, rotate: 0 } }], { x: 290, y: 105 })).toBe('turned')
      expect(hitTest([{ id: 'turned', box }], { x: 290, y: 105 })).toBeUndefined()
    })
    And('where two boxes overlap, the point hits the one drawn last', () => {
      const below = { x: 150, y: 120, w: 100, h: 60, rotate: 0 }
      expect(hitTest([{ id: 'below', box: below }, { id: 'turned', box }], { x: 200, y: 150 })).toBe('turned')
      expect(hitTest([{ id: 'turned', box }, { id: 'below', box: below }], { x: 200, y: 150 })).toBe('below')
    })
  })

  Scenario('Resizing from a corner keeps the opposite corner in place', ({ Given, When, Then }) => {
    let start: Box
    let box: Box
    Given('a box at 100, 100 of 200 by 100', () => {
      start = { x: 100, y: 100, w: 200, h: 100, rotate: 0 }
    })
    When('the bottom right handle moves 50 right and 20 down', () => {
      box = resizeBox(start, 'se', { x: 50, y: 20 })
    })
    Then('the box is at 100, 100 and 250 by 120', () => {
      expectBox(box, { x: 100, y: 100, w: 250, h: 120 })
    })
    When('the top left handle moves 50 right and 20 down instead', () => {
      box = resizeBox(start, 'nw', { x: 50, y: 20 })
    })
    Then('the box is at 150, 120 and 150 by 80', () => {
      expectBox(box, { x: 150, y: 120, w: 150, h: 80 })
    })
  })

  Scenario('Shift keeps the ratio', ({ Given, When, Then }) => {
    let start: Box
    let box: Box
    Given('a box at 100, 100 of 200 by 100', () => {
      start = { x: 100, y: 100, w: 200, h: 100, rotate: 0 }
    })
    When('the bottom right handle moves 100 right with the ratio kept', () => {
      box = resizeBox(start, 'se', { x: 100, y: 0 }, { keepRatio: true })
    })
    Then('the box is at 100, 100 and 300 by 150', () => {
      expectBox(box, { x: 100, y: 100, w: 300, h: 150 })
    })
    When('the right handle moves 100 right with the ratio kept instead', () => {
      box = resizeBox(start, 'e', { x: 100, y: 0 }, { keepRatio: true })
    })
    Then('the box is at 100, 75 and 300 by 150', () => {
      expectBox(box, { x: 100, y: 75, w: 300, h: 150 })
    })
  })

  Scenario('Resizing a turned box keeps the opposite corner where it was on the slide', ({ Given, When, Then, And }) => {
    let start: Box
    let box: Box
    Given('a box at 100, 100 of 200 by 100, turned 90 degrees', () => {
      start = { x: 100, y: 100, w: 200, h: 100, rotate: 90 }
    })
    When('the bottom right handle moves 30 left and 40 down on the slide', () => {
      box = resizeBox(start, 'se', { x: -30, y: 40 })
    })
    Then('the box is 240 by 130 and still turned 90 degrees', () => {
      // Turned a quarter clockwise, the box's width runs down the slide and its height runs left.
      expectBox(box, { w: 240, h: 130, rotate: 90 })
    })
    And('its top left corner is where it was on the slide', () => {
      const [before] = corners(start)
      const [after] = corners(box)
      expect(after.x).toBeCloseTo(before.x, 6)
      expect(after.y).toBeCloseTo(before.y, 6)
    })
  })

  Scenario('A resize never makes a box smaller than the smallest size', ({ Given, When, Then }) => {
    let start: Box
    let box: Box
    Given('a box at 100, 100 of 200 by 100', () => {
      start = { x: 100, y: 100, w: 200, h: 100, rotate: 0 }
    })
    When('the bottom right handle moves 500 left and 500 up', () => {
      box = resizeBox(start, 'se', { x: -500, y: -500 })
    })
    Then('the box is at 100, 100 and 8 by 8', () => {
      expectBox(box, { x: 100, y: 100, w: 8, h: 8 })
    })
  })

  Scenario('Turning follows the pointer, and Shift snaps to 15 degrees', ({ Given, When, Then, And }) => {
    let start: Box
    const from: Point = { x: 50, y: -50 }
    let to: Point
    Given('a box at 0, 0 of 100 by 100', () => {
      start = { x: 0, y: 0, w: 100, h: 100, rotate: 0 }
    })
    When('the rotate handle turns from straight up to 40 degrees', () => {
      const radians = 40 * Math.PI / 180
      to = { x: 50 + 100 * Math.sin(radians), y: 50 - 100 * Math.cos(radians) }
    })
    Then('the box turns 40 degrees', () => {
      expect(rotationFor(start, from, to)).toBeCloseTo(40, 6)
    })
    And('with Shift held it turns 45 degrees', () => {
      expect(rotationFor(start, from, to, { snap: true })).toBe(45)
    })
    And('an angle of 200 degrees reads as -160 degrees', () => {
      expect(normalizeAngle(200)).toBe(-160)
      expect(normalizeAngle(-180)).toBe(180)
    })
  })

  const moving: Bounds = { left: 100, top: 100, right: 300, bottom: 200 }
  const anElement = (Given: (title: string, run: () => void) => void) =>
    Given('an element from 100 to 300 across and 100 to 200 down', () => {})

  Scenario('Moving snaps to the slide\'s center line and shows a guide', ({ Given, When, Then, And }) => {
    let snapped: { delta: Point, guides: Guide[] }
    anElement(Given)
    When('it moves so its center is 3 units right of the slide\'s center', () => {
      snapped = snapMove(moving, { x: 490 + 3 - 200, y: 0 }, [])
    })
    Then('the move ends with its middle on the slide\'s center line', () => {
      expect(snapped.delta).toEqual({ x: 290, y: 0 })
    })
    And('an upright guide shows at 490 from the top of the slide to the bottom', () => {
      expect(snapped.guides).toEqual([{ axis: 'x', at: 490, from: 0, to: 551.25 }])
    })
  })

  Scenario('Moving snaps to another element\'s edge', ({ Given, And, When, Then }) => {
    let other: Bounds
    let snapped: { delta: Point, guides: Guide[] }
    anElement(Given)
    And('another element from 500 to 600 across and 300 to 400 down', () => {
      other = { left: 500, top: 300, right: 600, bottom: 400 }
    })
    When('it moves so its left edge is 4 units right of the other element\'s right edge', () => {
      snapped = snapMove(moving, { x: 604 - 100, y: 0 }, [other])
    })
    Then('the move ends with its left edge on the other element\'s right edge', () => {
      expect(snapped.delta).toEqual({ x: 500, y: 0 })
    })
    And('an upright guide shows at 600 spanning both elements', () => {
      expect(snapped.guides).toEqual([{ axis: 'x', at: 600, from: 100, to: 400 }])
    })
  })

  Scenario('Nothing snaps further than 5 units away', ({ Given, When, Then, And }) => {
    let snapped: { delta: Point, guides: Guide[] }
    anElement(Given)
    When('it moves so its center is 6 units right of the slide\'s center, 3 below the top of the slide', () => {
      snapped = snapMove(moving, { x: 490 + 6 - 200, y: 3 - 100 }, [])
    })
    Then('the move keeps its 6 units across and snaps its top to the top of the slide', () => {
      expect(snapped.delta).toEqual({ x: 296, y: -100 })
    })
    And('the only guide lies flat at 0', () => {
      expect(snapped.guides).toEqual([{ axis: 'y', at: 0, from: 0, to: 980 }])
    })
  })

  Scenario('A resized edge snaps to the slide\'s center line', ({ Given, When, Then, And }) => {
    let start: Box
    let result: { box: Box, guides: Guide[] }
    Given('a box whose right edge is 3 units left of the slide\'s center line', () => {
      start = { x: 300, y: 100, w: 187, h: 100, rotate: 0 }
    })
    When('Ana drags its right handle 4 units to the right', () => {
      result = snapResize(start, 'e', { x: 4, y: 0 }, [])
    })
    Then('the right edge sits on the center line and a guide shows it', () => {
      expectBox(result.box, { x: 300, y: 100, w: 190, h: 100, rotate: 0 })
      expect(result.guides).toEqual<Guide[]>([{ axis: 'x', at: 490, from: 0, to: 551.25 }])
    })
    And('the left edge stayed where it was', () => {
      expect(result.box.x).toBe(300)
    })
  })

  Scenario('A corner snaps each edge it pulls to another element', ({ Given, And, When, Then }) => {
    let start: Box
    let other: Bounds
    let result: { box: Box, guides: Guide[] }
    Given('a box at 100, 100 of 200 by 100', () => {
      start = { x: 100, y: 100, w: 200, h: 100, rotate: 0 }
    })
    And('another element from 400 to 500 across and 300 to 400 down', () => {
      other = { left: 400, top: 300, right: 500, bottom: 400 }
    })
    When('the bottom right handle moves 97 right and 197 down', () => {
      result = snapResize(start, 'se', { x: 97, y: 197 }, [other])
    })
    Then('the box is at 100, 100 and 300 by 300', () => {
      expectBox(result.box, { x: 100, y: 100, w: 300, h: 300 })
    })
    And('an upright guide and a flat one show at 400, each spanning both elements', () => {
      expect(result.guides).toEqual<Guide[]>([
        { axis: 'x', at: 400, from: 100, to: 400 },
        { axis: 'y', at: 400, from: 100, to: 500 },
      ])
    })
  })

  Scenario('Only the edges a handle pulls snap, and nothing further than 5 units away', ({ Given, When, Then }) => {
    let start: Box
    let result: { box: Box, guides: Guide[] }
    Given('a box at 3, 100 of 200 by 100', () => {
      start = { x: 3, y: 100, w: 200, h: 100, rotate: 0 }
    })
    When('the right handle moves 281 right, leaving its right edge 6 units left of the slide\'s center line', () => {
      result = snapResize(start, 'e', { x: 281, y: 0 }, [])
    })
    Then('the box is at 3, 100 and 481 by 100, with no guide', () => {
      // The left edge is 3 units from the slide's edge, but the right handle does not pull it.
      expectBox(result.box, { x: 3, y: 100, w: 481, h: 100 })
      expect(result.guides).toEqual([])
    })
    When('the left handle moves 1 right instead', () => {
      result = snapResize(start, 'w', { x: 1, y: 0 }, [])
    })
    Then('the box is at 0, 100 and 203 by 100, with a guide on the slide\'s left edge', () => {
      expectBox(result.box, { x: 0, y: 100, w: 203, h: 100 })
      expect(result.guides).toEqual<Guide[]>([{ axis: 'x', at: 0, from: 0, to: 551.25 }])
    })
  })

  Scenario('With the ratio kept, a snapped corner keeps the ratio', ({ Given, When, Then }) => {
    let start: Box
    let result: { box: Box, guides: Guide[] }
    Given('a box at 100, 100 of 200 by 100', () => {
      start = { x: 100, y: 100, w: 200, h: 100, rotate: 0 }
    })
    When('the bottom right handle moves 187 right with the ratio kept', () => {
      result = snapResize(start, 'se', { x: 187, y: 0 }, [], { keepRatio: true })
    })
    Then('the box is at 100, 100 and 390 by 195, with its right edge on the slide\'s center line', () => {
      expectBox(result.box, { x: 100, y: 100, w: 390, h: 195 })
      expect(result.guides).toEqual<Guide[]>([{ axis: 'x', at: 490, from: 0, to: 551.25 }])
    })
  })

  Scenario('The bottom edge can be left out of snapping', ({ Given, When, Then }) => {
    let start: Box
    let result: { box: Box, guides: Guide[] }
    Given('a box at 100, 100 of 200 by 100', () => {
      start = { x: 100, y: 100, w: 200, h: 100, rotate: 0 }
    })
    When('the bottom right handle moves 187 right and 3 down with the bottom edge left out', () => {
      // The bottom edge lands at 203, 3 units below the other element's top. Left out, it
      // stays where the pointer took it, and only the right edge snaps.
      result = snapResize(start, 'se', { x: 187, y: 3 }, [{ left: 600, top: 200, right: 700, bottom: 260 }], { axes: { y: false } })
    })
    Then('the box is at 100, 100 and 390 by 103, with only an upright guide', () => {
      expectBox(result.box, { x: 100, y: 100, w: 390, h: 103 })
      expect(result.guides.map(guide => guide.axis)).toEqual(['x'])
      // Asked to, the bottom edge snaps to the other element's top.
      expectBox(snapResize(start, 'se', { x: 187, y: 3 }, [{ left: 600, top: 200, right: 700, bottom: 260 }]).box, { w: 390, h: 100 })
    })
  })

  Scenario('A turned box resizes without snapping', ({ Given, When, Then, And }) => {
    let start: Box
    let result: { box: Box, guides: Guide[] }
    Given('a box whose right edge is 3 units left of the slide\'s center line, turned 10 degrees', () => {
      start = { x: 300, y: 100, w: 187, h: 100, rotate: 10 }
    })
    When('Ana drags its right handle 4 units to the right', () => {
      result = snapResize(start, 'e', { x: 4, y: 0 }, [])
    })
    Then('the box resizes as it would without snapping and no guide shows', () => {
      expect(result.box).toEqual(resizeBox(start, 'e', { x: 4, y: 0 }))
      expect(result.guides).toEqual([])
    })
    And('the same box turned a full circle snaps like an upright one', () => {
      const turned = snapResize({ ...start, rotate: 360 }, 'e', { x: 4, y: 0 }, [])
      expectBox(turned.box, { x: 300, y: 100, w: 190, h: 100 })
      expect(turned.guides.map(guide => guide.at)).toEqual([490])
    })
  })

  Scenario('An element always keeps part of itself on the slide', ({ Given, When, Then }) => {
    let delta: Point
    anElement(Given)
    When('it moves 1000 units left and 1000 units down', () => {
      delta = keepOnSlide(moving, { x: -1000, y: 1000 })
    })
    Then('the move ends with 20 units of it still on the slide each way', () => {
      expect(moving.right + delta.x).toBe(20)
      expect(moving.top + delta.y).toBe(551.25 - 20)
    })
  })

  Scenario('Elements moved together each keep part of themselves on the slide', ({ Given, And, When, Then }) => {
    let other: Bounds
    let delta: Point
    anElement(Given)
    And('another element from 500 to 700 across and 300 to 400 down, moving with it', () => {
      other = { left: 500, top: 300, right: 700, bottom: 400 }
    })
    When('they move 600 units left', () => {
      delta = keepOnSlide([moving, other], { x: -600, y: 0 })
    })
    Then('the move stops at 280 left, leaving 20 units of the first on the slide', () => {
      expect(delta).toEqual({ x: -280, y: 0 })
      expect(moving.right + delta.x).toBe(20)
    })
    And('a copy offset 20 right and down from elements near the bottom right corner goes only as far as leaves 20 units of each on the slide', () => {
      const corner = { left: 900, top: 480, right: 975, bottom: 545 }
      const inside = { left: 700, top: 300, right: 800, bottom: 400 }
      expect(keepOnSlide([inside, corner], { x: 20, y: 20 })).toEqual({ x: 20, y: 20 })
      const edge = { left: 950, top: 520, right: 1050, bottom: 620 }
      expect(keepOnSlide([inside, edge], { x: 20, y: 20 })).toEqual({ x: 10, y: 11.25 })
    })
  })

  Scenario('The rotate handle stays where the stage shows it', ({ Given, Then, And }) => {
    let view: View
    const handle = { gap: 24, size: 10 }
    Given('a stage of 980 by 551.25 pixels showing the whole slide', () => {
      view = fitView(STAGE)
    })
    Then('the rotate handle of a box at 100, 100 of 200 by 100 sits above it', () => {
      expect(rotateHandlePlace({ x: 100, y: 100, w: 200, h: 100, rotate: 0 }, view, STAGE, handle)).toBe('above')
    })
    And('for a box at the top of the slide it sits below it', () => {
      expect(rotateHandlePlace({ x: 100, y: 10, w: 200, h: 100, rotate: 0 }, view, STAGE, handle)).toBe('below')
    })
    And('for a box as tall as the slide it sits inside it, near its top', () => {
      expect(rotateHandlePlace({ x: 100, y: 0, w: 200, h: 551.25, rotate: 0 }, view, STAGE, handle)).toBe('inside')
    })
    And('for a box at the top turned upside down it stays off the box\'s own top edge, which now faces down', () => {
      expect(rotateHandlePlace({ x: 100, y: 10, w: 200, h: 100, rotate: 180 }, view, STAGE, handle)).toBe('above')
    })
  })

  Scenario('The whole slide fits the stage, centered', ({ Given, Then }) => {
    let view: View
    Given('a stage of 1000 by 1000 pixels', () => {
      view = fitView({ width: 1000, height: 1000 })
    })
    Then('the fitted slide is 1000 pixels wide and centered from top to bottom', () => {
      expect(980 * view.scale).toBeCloseTo(1000, 6)
      expect(view.x).toBeCloseTo(0, 6)
      expect(view.y).toBeCloseTo((1000 - 562.5) / 2, 6)
    })
  })

  Scenario('Two fingers zoom around the point between them, and pan', ({ Given, When, Then, And }) => {
    let start: View
    let view: View
    let fingers: [Point, Point]
    Given('a stage of 980 by 551.25 pixels showing the whole slide', () => {
      start = fitView(STAGE)
      expect(start).toEqual({ scale: 1, x: 0, y: 0 })
    })
    When('two fingers 100 pixels apart around 490, 275 spread to 200 pixels apart', () => {
      fingers = [{ x: 390, y: 275 }, { x: 590, y: 275 }]
      view = pinchView(start, [{ x: 440, y: 275 }, { x: 540, y: 275 }], fingers, STAGE)
    })
    Then('the zoom is 200 percent', () => {
      expect(view.scale).toBe(2)
    })
    And('the canvas point 490, 275 is still between the fingers', () => {
      expect(toCanvas(view, { x: 490, y: 275 })).toEqual({ x: 490, y: 275 })
    })
    When('both fingers then move 100 pixels to the right', () => {
      const before = view
      view = pinchView(start, [{ x: 440, y: 275 }, { x: 540, y: 275 }], [{ x: 490, y: 275 }, { x: 690, y: 275 }], STAGE)
      expect(view.scale).toBe(2)
      expect(view.y).toBe(before.y)
      start = before
    })
    Then('the slide moved 100 pixels to the right', () => {
      expect(view.x - start.x).toBe(100)
    })
  })

  Scenario('Zoom stays within its limits and the slide stays in sight', ({ Given, Then, And }) => {
    let view: View
    const middle = { x: 490, y: 275 }
    Given('a stage of 980 by 551.25 pixels showing the whole slide', () => {
      view = fitView(STAGE)
    })
    Then('zooming to 1000 percent stops at 400 percent', () => {
      expect(zoomAt(view, 10, middle, STAGE).scale).toBe(4)
    })
    And('zooming to 1 percent stops at 10 percent', () => {
      expect(zoomAt(view, 0.01, middle, STAGE).scale).toBe(0.1)
    })
    And('at 50 percent the slide cannot be pushed out of the stage', () => {
      expect(clampView({ scale: 0.5, x: -100, y: 400 }, STAGE)).toEqual({ scale: 0.5, x: 0, y: 551.25 - 275.625 })
    })
    And('at 200 percent it cannot be pulled away from the stage\'s edges', () => {
      expect(clampView({ scale: 2, x: 100, y: -2000 }, STAGE)).toEqual({ scale: 2, x: 0, y: -551.25 })
    })
  })
})
