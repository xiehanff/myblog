<script setup>
import { computed, ref } from 'vue'
import contentIndex from 'virtual:content-index'

const posts = ref(contentIndex.posts ?? [])

const postsSorted = computed(() =>
  [...posts.value].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : a.mtime
    const db = b.date ? new Date(b.date).getTime() : b.mtime
    return db - da
  }),
)

const latestPosts = computed(() => postsSorted.value.slice(0, 20))

const formatDate = (value) =>
  new Date(value).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

const categoryList = computed(() => {
  const counts = new Map()
  postsSorted.value.forEach((post) => {
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

const projects = [
  {
    name: 'cliper',
    href: 'https://github.com/xiehanff/cliper',
    meta: 'Flutter · 剪切板',
    description: '跨平台剪贴板管理器，支持 Windows / macOS。基于 Flutter 构建。',
    icon: 'image',
    image: 'https://raw.githubusercontent.com/xiehanff/cliper/master/assets/icon.png',
  },
  {
    name: 'plume_pdf',
    href: 'https://github.com/xiehanff/plume-pdf',
    meta: 'Flutter · PDF',
    description: '跨平台 PDF 阅读器，支持 Windows / macOS / Linux（.deb），重点打磨渲染性能，也在探索更自然的 AI 交互体验。',
    icon: 'image',
    image: 'https://github.com/xiehanff/plume-pdf/blob/main/assets/app_icon_128.png',
  },
  {
    name: 'mini_builder',
    href: 'https://github.com/xiehanff/mini_builder',
    meta: 'Flutter · 状态管理',
    description: '轻量级 Flutter 状态刷新工具，适用于页面级控制器、局部刷新和深层控制器注入。',
  },
]
</script>

<template>
  <div class="main-column content-column">
      <section class="hero card">
        <div>
          <h1>Code & Zen.</h1>
          <p class="lead">
            大前端工程化与道家思想探索空间
          </p>
        </div>
        <div class="hero-meta">
          <div>
            <p class="meta-label">文章数量</p>
            <p class="meta-value">{{ postsSorted.length }} 篇</p>
          </div>
          <div>
            <p class="meta-label">分类目录</p>
            <p class="meta-value">{{ categoryList.length }}</p>
          </div>
          <div>
            <p class="meta-label">最近更新</p>
            <p class="meta-value">{{ latestPosts.length }} 篇</p>
          </div>
        </div>
        <div class="hero-categories">
          <router-link
            v-for="category in categoryList"
            :key="category.path"
            class="hero-category-chip"
            :to="`/category/${category.path}`"
          >
            {{ category.name }} <span>({{ category.count }})</span>
          </router-link>
        </div>
      </section>

      <section id="latest" class="card">
        <div class="section-head">
          <h2>Recent Updates</h2>
        </div>
        <ul class="post-list">
          <li v-for="post in latestPosts" :key="post.path">
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
        <div class="more-link">
          <router-link to="/all">更多...</router-link>
        </div>
      </section>

      <section id="projects" class="card">
        <div class="section-head">
          <h2>Projects</h2>
          <a href="https://github.com/xiehanff?tab=repositories" target="_blank" rel="noreferrer" class="section-link">
            GitHub 主页
          </a>
        </div>
        <div class="project-grid">
          <a
            v-for="project in projects"
            :key="project.name"
            :href="project.href"
            target="_blank"
            rel="noreferrer"
            class="project-card"
            :class="{ 'project-card-no-icon': !project.icon && !project.image }"
          >
            <div
              v-if="project.icon || project.image"
              class="project-icon"
              :class="project.icon ? `project-icon-${project.icon}` : ''"
              aria-hidden="true"
            >
              <img
                v-if="project.image"
                :src="project.image"
                :alt="`${project.name} 图标`"
                loading="lazy"
              />
            </div>
            <div class="project-body">
              <h3>{{ project.name }}</h3>
              <p>{{ project.description }}</p>
              <span class="project-meta">{{ project.meta }}</span>
            </div>
          </a>
        </div>
      </section>

      <section id="about" class="card about">
        <div>
          <h2>About</h2>
          <p>
            这里记录前端工程化的实践思考，也写些技术之外的东西——道家思想、设计直觉、产品逻辑。
          </p>
          <p>
            欢迎随时来逛逛。
          </p>
        </div>
        <div class="about-links">
          <a href="mailto:xiehanff@gmail.com">xiehanff@gmail.com</a>
          <a href="https://github.com/xiehanff" target="_blank" rel="noreferrer">
            github.com/xiehanff
          </a>
        </div>
      </section>
  </div>
</template>
