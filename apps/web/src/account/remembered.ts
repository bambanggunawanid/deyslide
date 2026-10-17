import type { Router } from 'vue-router'
import type { AccountState } from '../composables/useAccount'

/** How often the page asks again while the server has not said who is signed in. */
const RECHECK_MS = 30_000

/**
 * On the website, keeps a remembered account in step with the server. When
 * the server did not answer at start (offline, say), the page shows the
 * person signed in last on this device with the projects kept for them. It
 * then asks again when the browser is back online and every half minute,
 * until the server answers: the same person changes nothing, and anyone
 * else (or nobody) takes the page home and swaps the projects. The apps
 * do this in `followAppAccount`.
 *
 * Returns a function that stops asking.
 */
export function followRememberedAccount(state: AccountState, router: Router, { recheckEvery = RECHECK_MS } = {}) {
  let asking = false

  async function ask() {
    if (asking || !state.service.unsure)
      return
    asking = true
    try {
      const next = await state.service.current()
      if (state.service.unsure || next?.id === state.account.value?.id)
        return
      await router.push({ name: 'home' })
      await state.setAccount(next)
    }
    catch {
      // The next try asks again.
    }
    finally {
      asking = false
    }
  }

  const recheck = () => void ask()
  window.addEventListener('online', recheck)
  const timer = setInterval(recheck, recheckEvery)
  return () => {
    window.removeEventListener('online', recheck)
    clearInterval(timer)
  }
}
