<script setup>
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import contentIndex from 'virtual:content-index'

const posts = ref(contentIndex.posts ?? [])
const route = useRoute()

const categoryPath = computed(() => {
  const param = route.params.path
  if (!param) return ''
  return decodeURIComponent(Array.isArray(param) ? param.join('/') : param)
})

const filteredPosts = computed(() => {
  const filtered = categoryPath.value
    ? posts.value.filter((post) => {
        const path = post.categories.join('/')
        return path === categoryPath.value || path.startsWith(`${categoryPath.value}/`)
      })
    : posts.value
  return [...filtered].sort((a, b) =>
    a.path.localeCompare(b.path, 'zh-Hans-CN', { numeric: true }),
  )
})

const childCategories = computed(() => {
  const parent = categoryPath.value.split('/').filter(Boolean)
  if (!parent.length) return []

  const counts = new Map()
  posts.value.forEach((post) => {
    const categories = post.categories ?? []
    if (categories.length <= parent.length) return
    if (!parent.every((part, index) => categories[index] === part)) return

    const name = categories[parent.length]
    counts.set(name, (counts.get(name) ?? 0) + 1)
  })

  return Array.from(counts, ([name, count]) => ({
    name,
    count,
    path: [...parent, name].join('/'),
  })).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
})

const formatDate = (value) =>
  new Date(value).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
</script>

<template>
  <section class="card content-column">
      <div class="section-head">
        <h2>分类：{{ categoryPath }}</h2>
        <router-link class="section-link" to="/">返回首页</router-link>
      </div>
      <nav v-if="childCategories.length" class="category-list category-children" aria-label="子分类">
        <router-link
          v-for="category in childCategories"
          :key="category.path"
          class="category-link"
          :to="`/category/${category.path}`"
        >
          {{ category.name }} <span>({{ category.count }})</span>
        </router-link>
      </nav>
      <ul class="post-list">
        <li v-for="post in filteredPosts" :key="post.path">
          <router-link class="post-link" :to="`/post/${post.path}`">
            <article class="post">
              <div class="post-date">{{ formatDate(post.date || post.mtime) }}</div>
              <div>
                <h3>{{ post.title }}</h3>
              </div>
            </article>
          </router-link>
        </li>
      </ul>
  </section>
</template>

<style scoped>
.category-children {
  flex-direction: row;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
</style>
