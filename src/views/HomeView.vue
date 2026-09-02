<script setup>
import { computed, ref } from 'vue'
import contentIndex from 'virtual:content-index'
import miniBuilderIcon from '../assets/minibuilder-icon.png'

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
    description:
      '常驻系统托盘的剪贴板历史管理器，自动记录文本、图片、链接与文件，智能识别 JSON 和网址，支持分组整理与拖拽归档，数据全部本地存储。',
    image: 'https://raw.githubusercontent.com/xiehanff/cliper/master/assets/icon.png',
    iconScale: 0.8,
  },
  {
    name: 'plume_pdf',
    href: 'https://github.com/xiehanff/plume-pdf',
    meta: 'Flutter · PDF',
    description:
      '基于 Flutter + PDFium 的跨平台 PDF 阅读器，支持目录跳转、双页阅读与阅读主题，集成 DeepSeek AI 框选翻译、解释与流式多轮对话。',
    image: 'https://raw.githubusercontent.com/xiehanff/plume-pdf/main/assets/app_icon_128.png',
    iconScale: 1,
  },
  {
    name: 'mini_builder',
    href: 'https://github.com/xiehanff/mini_builder',
    meta: 'Flutter · 状态管理',
    description:
      '轻量级 Flutter 状态刷新工具：MiniNotifier 提供生命周期与按 id 局部刷新，MiniBuilder 按需重建，MiniProvider 深层注入控制器。',
    image: miniBuilderIcon,
    iconScale: 1,
  },
  {
    name: 'hax_danmu',
    href: 'https://github.com/xiehanff/HaxDanmu',
    meta: 'Flutter · 弹幕组件',
    description:
      '轨道式 Flutter 弹幕组件，引擎与渲染分离，支持发送、暂停、继续与清空，防追尾调度避免同轨碰撞，空闲时自动停止帧推进。',
    image: 'https://raw.githubusercontent.com/xiehanff/HaxDanmu/main/example/assets/icon.png',
    iconScale: 0.96,
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
          >
            <div class="project-head">
              <div class="project-icon" aria-hidden="true">
                <img
                  :src="project.image"
                  :alt="`${project.name} 图标`"
                  :style="{ transform: `scale(${project.iconScale ?? 1})` }"
                />
              </div>
              <h3 class="project-title">
                {{ project.name }}
              </h3>
            </div>
            <p class="project-description">
              {{ project.description }}
            </p>
            <span class="project-meta">
              {{ project.meta }}
            </span>
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
