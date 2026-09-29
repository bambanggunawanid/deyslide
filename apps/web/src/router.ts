import type { RouterHistory } from 'vue-router'
import type { Account } from './account/types'
import { createRouter } from 'vue-router'
import HomePage from './pages/HomePage.vue'
import NotFoundPage from './pages/NotFoundPage.vue'
import ProjectPage from './pages/ProjectPage.vue'

declare module 'vue-router' {
  interface RouteMeta {
    /** Pages for signing in, which a signed in person has no use for. */
    signedOutOnly?: boolean
    /** Pages that use the full window width, such as the editor. */
    wide?: boolean
  }
}

export function createAppRouter(history: RouterHistory, currentAccount: () => Account | undefined = () => undefined) {
  const router = createRouter({
    history,
    routes: [
      { path: '/', name: 'home', component: HomePage },
      { path: '/p/:projectId', name: 'project', component: ProjectPage, props: true },
      { path: '/p/:projectId/d/:deckId', name: 'deck', component: () => import('./pages/DeckPage.vue'), props: true, meta: { wide: true } },
      { path: '/sign-in', name: 'sign-in', component: () => import('./pages/SignInPage.vue'), meta: { signedOutOnly: true } },
      { path: '/sign-up', name: 'sign-up', component: () => import('./pages/SignUpPage.vue'), meta: { signedOutOnly: true } },
      { path: '/forgot-password', name: 'forgot-password', component: () => import('./pages/ForgotPasswordPage.vue'), meta: { signedOutOnly: true } },
      { path: '/reset-password', name: 'reset-password', component: () => import('./pages/ResetPasswordPage.vue') },
      { path: '/:rest(.*)*', name: 'not-found', component: NotFoundPage },
    ],
  })
  router.beforeEach(to => to.meta.signedOutOnly && currentAccount() ? { name: 'home' } : true)
  return router
}
