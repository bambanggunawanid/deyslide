export type SortStep =
  | { kind: 'compare', indices: [number, number], values: number[] }
  | { kind: 'swap', indices: [number, number], values: number[] }
  | { kind: 'settle', index: number, values: number[] }

/**
 * Records every decision bubble sort makes so an animation can replay it
 * one frame accurate step at a time. The input array is never mutated.
 */
export function bubbleSortSteps(input: readonly number[]): SortStep[] {
  const values = [...input]
  const steps: SortStep[] = []

  for (let end = values.length - 1; end > 0; end--) {
    let swapped = false
    for (let i = 0; i < end; i++) {
      steps.push({ kind: 'compare', indices: [i, i + 1], values: [...values] })
      if (values[i] > values[i + 1]) {
        [values[i], values[i + 1]] = [values[i + 1], values[i]]
        swapped = true
        steps.push({ kind: 'swap', indices: [i, i + 1], values: [...values] })
      }
    }
    steps.push({ kind: 'settle', index: end, values: [...values] })
    if (!swapped) {
      for (let rest = end - 1; rest >= 0; rest--)
        steps.push({ kind: 'settle', index: rest, values: [...values] })
      return steps
    }
  }

  if (values.length > 0)
    steps.push({ kind: 'settle', index: 0, values: [...values] })
  return steps
}

export function finalValues(steps: readonly SortStep[], input: readonly number[]): number[] {
  const last = steps.at(-1)
  return last ? [...last.values] : [...input]
}
