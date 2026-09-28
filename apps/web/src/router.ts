import type { RouterHistory } from 'vue-router'
import { createRouter } from 'vue-router'
import HomePage from './pages/HomePage.vue'
import NotFoundPage from './pages/NotFoundPage.vue'
import ProjectPage from './pages/ProjectPage.vue'

export function createAppRouter(history: RouterHistory) {
  return createRouter({
    history,
    routes: [
      { path: '/', name: 'home', component: HomePage },
      { path: '/p/:projectId', name: 'project', component: ProjectPage, props: true },
      { path: '/p/:projectId/d/:deckId', name: 'deck', component: () => import('./pages/DeckPage.vue'), props: true },
      { path: '/:rest(.*)*', name: 'not-found', component: NotFoundPage },
    ],
  })
}
