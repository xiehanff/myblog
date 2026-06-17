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

const postsSorted = computed(() =>
  [...posts.value].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : a.mtime
    const db = b.date ? new Date(b.date).getTime() : b.mtime
    return db - da
  }),
)

const filteredPosts = computed(() => {
  if (!categoryPath.value) return postsSorted.value
  return postsSorted.value.filter((post) =>
    post.categories.join('/').startsWith(categoryPath.value),
  )
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
