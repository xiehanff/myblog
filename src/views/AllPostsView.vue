<script setup>
import { computed, ref } from 'vue'
import contentIndex from 'virtual:content-index'

const posts = ref(contentIndex.posts ?? [])

const postsSorted = computed(() =>
  [...posts.value].sort((a, b) => b.mtime - a.mtime),
)

// 按分类分组的文章
const postsByCategory = computed(() => {
  const groups = new Map()
  postsSorted.value.forEach((post) => {
    post.categories.forEach((cat) => {
      if (!groups.has(cat)) {
        groups.set(cat, [])
      }
      groups.get(cat).push(post)
    })
  })
  return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
})

const formatDate = (value) =>
  new Date(value).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
</script>

<template>
  <div class="main-column content-column">
    <section class="card">
      <div class="section-head">
        <h2>全部文章</h2>
        <p class="section-desc">按分类浏览所有文章</p>
      </div>
      <div v-for="[category, catPosts] in postsByCategory" :key="category" class="category-group">
        <h3 class="category-title">{{ category }}</h3>
        <ul class="post-list">
          <li v-for="post in catPosts" :key="post.path">
            <router-link class="post-link" :to="`/post/${post.path}`">
              <article class="post">
                <div class="post-date">{{ formatDate(post.mtime) }}</div>
                <div>
                  <h3>{{ post.title }}</h3>
                </div>
              </article>
            </router-link>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>
