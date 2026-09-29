import type { VueWrapper } from '@vue/test-utils'
import type { Router } from 'vue-router'
import type { AccountService } from '../../apps/web/src/account/types'
import { flushPromises, mount } from '@vue/test-utils'
import { expect, vi } from 'vitest'
import { shallowRef } from 'vue'
import { createMemoryHistory } from 'vue-router'
import App from '../../apps/web/src/App.vue'
import { ACCOUNT_KEY } from '../../apps/web/src/composables/useAccount'
import { GUEST_STORE_KEY } from '../../apps/web/src/composables/useGuestStore'
import { MemoryGuestStorage } from '../../apps/web/src/guest/memory-storage'
import { GuestStore } from '../../apps/web/src/guest/store'
import { createAppRouter } from '../../apps/web/src/router'
import { FakeAccountService } from './account'

// Dialogs and menus render in portals on document.body, outside the wrapper.
export const find = (selector: string) => document.body.querySelector<HTMLElement>(selector)
export const findAll = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
export const text = (selector: string) => find(selector)?.textContent?.trim() ?? ''
export const pageText = () => document.body.textContent?.replace(/\s+/g, ' ') ?? ''

/** The web app as it runs in the browser, with memory storage and routing. */
export async function mountWebApp({ path = '/', service = new FakeAccountService() as AccountService } = {}) {
  const store = await GuestStore.open(new MemoryGuestStorage())
  const account = { service, options: await service.options(), account: shallowRef(await service.current()) }
  const router: Router = createAppRouter(createMemoryHistory(), () => account.account.value)
  await router.push(path)
  const wrapper: VueWrapper = mount(App, {
    attachTo: document.body,
    global: {
      plugins: [router],
      provide: { [GUEST_STORE_KEY as symbol]: store, [ACCOUNT_KEY as symbol]: account },
    },
  })

  async function settle() {
    await flushPromises()
    await router.isReady()
    await flushPromises()
  }

  async function waitFor(selector: string) {
    await vi.waitFor(() => expect(find(selector)).not.toBeNull())
    return find(selector)!
  }

  async function click(selector: string) {
    (await waitFor(selector)).click()
    await settle()
  }

  async function fill(selector: string, value: string) {
    const input = await waitFor(selector) as HTMLInputElement
    input.value = value
    input.dispatchEvent(new Event('input'))
    await settle()
  }

  async function submit(selector: string) {
    (await waitFor(selector)).dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
  }

  function unmount() {
    wrapper.unmount()
    document.body.innerHTML = ''
  }

  await settle()
  return { store, account, router, wrapper, settle, waitFor, click, fill, submit, unmount }
}

export type WebApp = Awaited<ReturnType<typeof mountWebApp>>
