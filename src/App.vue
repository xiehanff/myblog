<script setup>
import { computed, ref } from 'vue'
import contentIndex from 'virtual:content-index'

const posts = ref(contentIndex.posts ?? [])
const menuOpen = ref(false)
const mobileCategoriesOpen = ref(false)

const categoryList = computed(() => {
  const counts = new Map()
  posts.value.forEach((post) => {
    let current = ''
    post.categories.forEach((part) => {
      current = current ? `${current}/${part}` : part
      counts.set(current, (counts.get(current) ?? 0) + 1)
    })
  })
  return Array.from(counts.entries())
    .map(([path, count]) => ({
      path,
      name: path.split('/').at(-1),
      depth: path.split('/').length - 1,
      count,
    }))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'))
})

const closeMenus = () => {
  menuOpen.value = false
  mobileCategoriesOpen.value = false
}

const toggleMenu = () => {
  menuOpen.value = !menuOpen.value
  if (!menuOpen.value) {
    mobileCategoriesOpen.value = false
  }
}

const toggleMobileCategories = () => {
  mobileCategoriesOpen.value = !mobileCategoriesOpen.value
}
</script>

<template>
  <header class="site-header">
    <nav class="nav" aria-label="主导航" :class="{ 'nav-open': menuOpen }">
      <div class="nav-topbar">
        <router-link class="logo" to="/" @click="closeMenus">
          <span class="logo-main">Hax Blog</span>
          <span class="logo-sub">· Engineering And Zen</span>
        </router-link>
        <button
          class="nav-toggle"
          type="button"
          :aria-label="menuOpen ? '关闭导航菜单' : '打开导航菜单'"
          :aria-expanded="menuOpen ? 'true' : 'false'"
          aria-controls="mobile-nav-panel"
          @click="toggleMenu"
        >
          <span></span>
          <span></span>
          <span></span>
        </button>
      </div>

      <div class="nav-links nav-links-desktop">
        <router-link to="/all">全部</router-link>
        <div class="nav-dropdown">
          <button class="nav-dropdown-trigger" type="button">分类</button>
          <div class="nav-dropdown-menu">
            <router-link
              v-for="category in categoryList"
              :key="category.path"
              class="nav-dropdown-link"
              :to="`/category/${category.path}`"
              :style="{ paddingLeft: `${category.depth * 14 + 16}px` }"
            >
              {{ category.name }} <span>({{ category.count }})</span>
            </router-link>
          </div>
        </div>
        <router-link :to="{ path: '/', hash: '#about' }">关于</router-link>
        <a href="mailto:hello@myblog.com">邮箱</a>
        <a href="https://github.com/xiehanff" target="_blank" rel="noreferrer">GitHub</a>
      </div>

      <div id="mobile-nav-panel" class="nav-panel" :class="{ 'is-open': menuOpen }">
        <div class="nav-links nav-links-mobile">
          <router-link to="/all" @click="closeMenus">
            全部
          </router-link>
          <div class="nav-mobile-group">
            <button
              class="nav-mobile-trigger"
              type="button"
              :aria-expanded="mobileCategoriesOpen ? 'true' : 'false'"
              @click="toggleMobileCategories"
            >
              <span>分类</span>
              <span class="nav-mobile-caret" :class="{ 'is-open': mobileCategoriesOpen }">
                +
              </span>
            </button>
            <div
              class="nav-mobile-categories"
              :class="{ 'is-open': mobileCategoriesOpen }"
            >
              <router-link
                v-for="category in categoryList"
                :key="category.path"
                class="nav-dropdown-link"
                :to="`/category/${category.path}`"
                :style="{ paddingLeft: `${category.depth * 14 + 16}px` }"
                @click="closeMenus"
              >
                {{ category.name }} <span>({{ category.count }})</span>
              </router-link>
            </div>
          </div>
          <router-link :to="{ path: '/', hash: '#about' }" @click="closeMenus">
            关于
          </router-link>
          <a href="mailto:xiehanff@gmail.com" @click="closeMenus">邮箱</a>
          <a href="https://github.com/xiehanff" target="_blank" rel="noreferrer" @click="closeMenus">
            GitHub
          </a>
        </div>
      </div>
    </nav>
  </header>

  <main class="layout">
    <router-view />
  </main>

  <footer class="footer">
    <p>© 2026 Hax Blog · Engineering And Zen</p>
  </footer>
</template>
