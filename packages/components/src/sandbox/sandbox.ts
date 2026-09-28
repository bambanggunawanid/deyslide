export type SandboxValue = boolean | number | string
export type SandboxState = Record<string, SandboxValue>

export interface SandboxChange {
  key: string
  from: SandboxValue
  to: SandboxValue
}

export interface SandboxModel {
  readonly state: SandboxState
  readonly history: readonly SandboxChange[]
  set: (key: string, value: SandboxValue) => void
  toggle: (key: string) => void
  step: (key: string, amount: number) => void
  undo: () => void
  reset: () => void
  snapshot: () => string
}

export const DEFAULT_HISTORY_LIMIT = 20

export class SandboxError extends Error {}

/**
 * State model behind `<DeyslideLiveSandbox>`.
 * It is plain TypeScript so the rules can be tested without a browser.
 * Pass a Vue `reactive` factory to get a reactive model inside components.
 */
export function createSandboxModel(
  initial: SandboxState,
  options: { historyLimit?: number, wrap?: <T extends object>(value: T) => T } = {},
): SandboxModel {
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
  const wrap = options.wrap ?? (<T>(value: T) => value)
  const baseline: SandboxState = { ...initial }
  const state = wrap<SandboxState>({ ...initial })
  const history = wrap<SandboxChange[]>([])

  function assertKey(key: string) {
    if (!(key in state))
      throw new SandboxError(`Unknown sandbox key "${key}"`)
  }

  function record(change: SandboxChange) {
    history.push(change)
    if (history.length > historyLimit)
      history.splice(0, history.length - historyLimit)
  }

  function set(key: string, value: SandboxValue) {
    assertKey(key)
    const from = state[key]
    if (typeof from !== typeof value)
      throw new SandboxError(`Key "${key}" holds a ${typeof from}, got a ${typeof value}`)
    if (from === value)
      return
    state[key] = value
    record({ key, from, to: value })
  }

  return {
    state,
    history,
    set,
    toggle(key) {
      assertKey(key)
      const current = state[key]
      if (typeof current !== 'boolean')
        throw new SandboxError(`Key "${key}" is not a boolean`)
      set(key, !current)
    },
    step(key, amount) {
      assertKey(key)
      const current = state[key]
      if (typeof current !== 'number')
        throw new SandboxError(`Key "${key}" is not a number`)
      set(key, current + amount)
    },
    undo() {
      const last = history.pop()
      if (last)
        state[last.key] = last.from
    },
    reset() {
      for (const key of Object.keys(state))
        delete state[key]
      Object.assign(state, baseline)
      history.splice(0, history.length)
    },
    snapshot() {
      return JSON.stringify(state, null, 2)
    },
  }
}
