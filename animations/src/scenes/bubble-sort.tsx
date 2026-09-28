import { makeScene2D, Rect, Txt } from '@motion-canvas/2d'
import { all, createRef, makeRef, waitFor } from '@motion-canvas/core'
import { bubbleSortSteps } from '../logic/bubble-sort-steps'

export const INPUT = [5, 2, 8, 1, 9, 3, 7]

const COLORS = {
  background: '#0b1020',
  bar: '#334155',
  compare: '#38bdf8',
  swap: '#f472b6',
  settled: '#34d399',
  text: '#e2e8f0',
  muted: '#94a3b8',
}

const BAR_WIDTH = 120
const BAR_GAP = 36
const UNIT_HEIGHT = 56
const BASELINE = 300
const STEP_TIME = 0.35

function slotX(index: number) {
  return (index - (INPUT.length - 1) / 2) * (BAR_WIDTH + BAR_GAP)
}

export default makeScene2D(function* (view) {
  view.fill(COLORS.background)

  const bars: Rect[] = []
  const status = createRef<Txt>()
  const settled = new Set<number>()

  view.add(
    <Txt
      y={-420}
      text="Bubble sort"
      fill={COLORS.text}
      fontFamily="JetBrains Mono, monospace"
      fontSize={64}
      fontWeight={700}
    />,
  )
  view.add(
    <Txt
      ref={status}
      y={-330}
      text="Start"
      fill={COLORS.muted}
      fontFamily="JetBrains Mono, monospace"
      fontSize={40}
    />,
  )

  INPUT.forEach((value, index) => {
    view.add(
      <Rect
        ref={makeRef(bars, index)}
        x={slotX(index)}
        y={BASELINE}
        offset={[0, 1]}
        width={BAR_WIDTH}
        height={value * UNIT_HEIGHT}
        radius={12}
        fill={COLORS.bar}
      >
        <Txt
          y={-(value * UNIT_HEIGHT) / 2}
          text={String(value)}
          fill={COLORS.text}
          fontFamily="JetBrains Mono, monospace"
          fontSize={44}
        />
      </Rect>,
    )
  })

  const restColor = (index: number) => (settled.has(index) ? COLORS.settled : COLORS.bar)

  yield* waitFor(0.6)

  for (const step of bubbleSortSteps(INPUT)) {
    if (step.kind === 'compare') {
      const [a, b] = step.indices
      status().text(`Compare ${step.values[a]} and ${step.values[b]}`)
      yield* all(bars[a].fill(COLORS.compare, STEP_TIME / 2), bars[b].fill(COLORS.compare, STEP_TIME / 2))
      yield* waitFor(STEP_TIME / 2)
      yield* all(bars[a].fill(restColor(a), STEP_TIME / 3), bars[b].fill(restColor(b), STEP_TIME / 3))
    }
    else if (step.kind === 'swap') {
      const [a, b] = step.indices
      status().text(`Swap ${step.values[b]} and ${step.values[a]}`)
      yield* all(
        bars[a].fill(COLORS.swap, STEP_TIME / 3),
        bars[b].fill(COLORS.swap, STEP_TIME / 3),
        bars[a].position.x(slotX(b), STEP_TIME),
        bars[b].position.x(slotX(a), STEP_TIME),
      );
      [bars[a], bars[b]] = [bars[b], bars[a]]
      yield* all(bars[a].fill(restColor(a), STEP_TIME / 3), bars[b].fill(restColor(b), STEP_TIME / 3))
    }
    else {
      settled.add(step.index)
      status().text(`Position ${step.index} is final`)
      yield* bars[step.index].fill(COLORS.settled, STEP_TIME / 2)
    }
  }

  status().text('Sorted')
  yield* waitFor(1.5)
})
