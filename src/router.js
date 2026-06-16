import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'
import PostView from './views/PostView.vue'
import CategoryView from './views/CategoryView.vue'
import AllPostsView from './views/AllPostsView.vue'

const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', component: HomeView },
    { path: '/all', component: AllPostsView },
    { path: '/post/:path(.*)', component: PostView },
    { path: '/category/:path(.*)', component: CategoryView },
  ],
  scrollBehavior(to) {
    if (to.hash) {
      return { el: to.hash, top: 80, behavior: 'smooth' }
    }
    return { top: 0 }
  },
})

export default router
