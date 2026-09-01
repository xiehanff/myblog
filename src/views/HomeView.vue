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

const latestPosts = computed(() => postsSorted.value.slice(0, 8))

const formatDate = (value) =>
  new Date(value).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
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
    description: '跨平台 PDF 阅读器，覆盖 Windows / macOS / Linux / Android / iOS。基于 Flutter + PDFium，持续打磨阅读与渲染体验，并探索更自然的 AI 辅助阅读交互。',
    icon: 'image',
    image: 'https://raw.githubusercontent.com/xiehanff/plume-pdf/main/assets/app_icon_128.png',
  },
  {
    name: 'mini_builder',
    href: 'https://github.com/xiehanff/mini_builder',
    meta: 'Flutter · 状态管理',
    description: '轻量级 Flutter 状态刷新工具，适用于页面级控制器、局部刷新和深层控制器注入。',
    icon: 'image',
    image: '/minibuilder-icon.png',
  },
]
</script>

<template>
  <div class="main-column content-column">
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
          <p class="about-name">hax</p>
          <p class="about-bio">
            Flutter / iOS Engineer
          </p>
          <p class="about-locate">
            Wuhan, China
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
