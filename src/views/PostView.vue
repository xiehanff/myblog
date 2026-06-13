<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import markdownItKatex from '@traptitech/markdown-it-katex'
import 'katex/dist/katex.min.css'
import contentIndex from 'virtual:content-index'

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: (str, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang }).value
      } catch (error) {
        console.error(error)
      }
    }
    return hljs.highlightAuto(str).value
  },
})
md.use(markdownItKatex, {
  throwOnError: false,
  errorColor: '#cc0000',
})
const defaultImageRenderer =
  md.renderer.rules.image ||
  ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))

const route = useRoute()
const postModules = import.meta.glob('../../content/**/*.md', {
  query: '?raw',
  import: 'default',
})
const baseUrl = import.meta.env.BASE_URL || '/'
const basePrefix = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
const safeDecode = (value) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
const encodePath = (value) =>
  value
    .split('/')
    .map((part) => encodeURIComponent(safeDecode(part)))
    .join('/')
const normalizePath = (value = '') => value.replace(/^\/+/, '')
const buildContentUrl = (pathValue) =>
  pathValue ? `${basePrefix}content/${encodePath(normalizePath(pathValue))}` : ''
const parseFrontmatter = (raw) => {
  if (!raw.startsWith('---')) {
    return { data: {}, body: raw }
  }
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) {
    return { data: {}, body: raw }
  }
  const data = match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((acc, line) => {
      const separatorIndex = line.indexOf(':')
      if (separatorIndex === -1) return acc
      const key = line.slice(0, separatorIndex).trim()
      const value = line.slice(separatorIndex + 1).trim()
      if (!key) return acc
      acc[key] = value.replace(/^['"]|['"]$/g, '')
      return acc
    }, {})

  return {
    data,
    body: raw.slice(match[0].length),
  }
}
const resolveContentPath = (sourcePath, relativePath) => {
  if (!relativePath) return ''
  if (/^(https?:)?\/\//i.test(relativePath)) return relativePath
  const baseDir = sourcePath.split('/').slice(0, -1).join('/')
  const base = `http://local/${baseDir ? `${baseDir}/` : ''}`
  const resolved = new URL(relativePath, base).pathname.replace(/^\/+/, '')
  return buildContentUrl(resolved)
}

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const srcIndex = token.attrIndex('src')
  if (srcIndex >= 0) {
    const src = token.attrs[srcIndex][1]
    const isRemote = /^(https?:)?\/\//i.test(src)
    if (!isRemote && env?.basePath) {
      const base = `http://local/${env.basePath.replace(/^\/+/, '')}/`
      const resolved = new URL(src, base).pathname.replace(/^\/+/, '')
      token.attrs[srcIndex][1] = `${basePrefix}content/${encodePath(resolved)}`
    }
  }
  return defaultImageRenderer(tokens, idx, options, env, self)
}

const postLoaders = Object.entries(postModules).reduce((acc, [key, loader]) => {
  const relative = key.replace(/^(\.\.\/)+content\//, '')
  acc[relative] = loader
  acc[decodeURIComponent(relative)] = loader
  acc[encodeURI(relative)] = loader
  acc[encodePath(relative)] = loader
  return acc
}, {})
const posts = ref(contentIndex.posts ?? [])
const postContent = ref('')
const postFrontmatter = ref({})
const isLoading = ref(false)
const tocOpen = ref(false)
const activeHeadingId = ref('')
const postBodyRef = ref(null)

const activePath = computed(() => {
  const param = route.params.path
  if (!param) return ''
  const raw = Array.isArray(param) ? param.join('/') : param
  return normalizePath(decodeURIComponent(raw))
})

const activePost = computed(() =>
  posts.value.find((post) => post.path === activePath.value),
)

const formatDate = (value) =>
  new Date(value).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

const resolveLoader = (pathValue) => {
  if (postLoaders[pathValue]) return postLoaders[pathValue]
  const encoded = encodePath(pathValue)
  if (postLoaders[encoded]) return postLoaders[encoded]
  const decoded = decodeURIComponent(pathValue)
  if (postLoaders[decoded]) return postLoaders[decoded]
  const fallback = Object.entries(postLoaders).find(
    ([key]) => decodeURIComponent(key) === pathValue,
  )
  return fallback ? fallback[1] : null
}

const resolveRawContent = (loaded) => {
  if (typeof loaded === 'string') return loaded.replace(/^\uFEFF/, '')
  if (loaded && typeof loaded.default === 'string') {
    return loaded.default.replace(/^\uFEFF/, '')
  }
  return ''
}

const sanitizeMarkdownDestinations = (content) =>
  content.replace(/(!?\[[^\]]*]\()([^)\n]+)(\))/g, (match, prefix, destination, suffix) => {
    const target = destination.trim()
    if (!target) return match
    if (target.startsWith('<') || /^(https?:|mailto:|#)/i.test(target)) {
      return `${prefix}${target}${suffix}`
    }
    return `${prefix}${target.replace(/ /g, '%20')}${suffix}`
  })

const fetchPostContent = async (pathValue) => {
  const response = await fetch(buildContentUrl(pathValue))
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status}`)
  }
  return (await response.text()).replace(/^\uFEFF/, '')
}

const loadPost = async (pathValue) => {
  const loader = resolveLoader(pathValue)
  isLoading.value = true
  tocOpen.value = false
  activeHeadingId.value = ''
  try {
    if (loader) {
      const loaded = await loader()
      const raw = resolveRawContent(loaded)
      if (raw.trim()) {
        const { data, body } = parseFrontmatter(raw)
        postFrontmatter.value = data
        postContent.value = sanitizeMarkdownDestinations(body)
        return
      }
    }

    const fetched = await fetchPostContent(pathValue)
    const { data, body } = parseFrontmatter(fetched)
    postFrontmatter.value = data
    postContent.value = sanitizeMarkdownDestinations(body)
  } catch (error) {
    console.error(error)
    postFrontmatter.value = {}
    postContent.value = '# 未找到文章\n\n请返回首页重新选择。'
  } finally {
    isLoading.value = false
  }
}

watch(
  activePath,
  (value) => {
    if (value) loadPost(value)
  },
  { immediate: true },
)

const extractInlineText = (token) => {
  if (!token) return ''
  if (token.type === 'text' || token.type === 'code_inline') {
    return token.content
  }
  if (Array.isArray(token.children) && token.children.length > 0) {
    return token.children.map(extractInlineText).join('')
  }
  return token.content || ''
}

const slugifyHeading = (value) =>
  value
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')

const renderPost = computed(() => {
  const basePath = activePath.value.split('/').slice(0, -1).join('/')
  const env = { basePath }
  const tokens = md.parse(postContent.value, env)
  const slugCounts = new Map()
  const toc = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type !== 'heading_open') continue

    const level = Number(token.tag.slice(1))
    const inlineToken = tokens[index + 1]
    const text = extractInlineText(inlineToken).trim()
    if (!text) continue

    const baseSlug = slugifyHeading(text) || `section-${toc.length + 1}`
    const duplicateCount = slugCounts.get(baseSlug) ?? 0
    slugCounts.set(baseSlug, duplicateCount + 1)
    const id = duplicateCount === 0 ? baseSlug : `${baseSlug}-${duplicateCount + 1}`

    token.attrSet('id', id)
    if (level === 2 || level === 3) {
      toc.push({
        id,
        text,
        level,
      })
    }
  }

  const dateHtml = activePost.value
    ? `<p class="post-date-inline">${formatDate(activePost.value.mtime)}</p>`
    : ''
  let html = md.renderer.render(tokens, md.options, env)
  if (dateHtml) {
    html = html.replace(/(<h1[^>]*>[\s\S]*?<\/h1>)/, `$1${dateHtml}`)
  }

  return {
    html,
    toc,
  }
})

const renderedPost = computed(() => renderPost.value.html)
const tocItems = computed(() => renderPost.value.toc)

const updateActiveHeading = () => {
  const headings = postBodyRef.value?.querySelectorAll('h2[id], h3[id]')
  if (!headings?.length) {
    activeHeadingId.value = ''
    return
  }

  const offset = 140
  let currentId = headings[0].id
  headings.forEach((heading) => {
    if (heading.getBoundingClientRect().top - offset <= 0) {
      currentId = heading.id
    }
  })
  activeHeadingId.value = currentId
}

watch(
  renderedPost,
  async () => {
    await nextTick()
    updateActiveHeading()
  },
  { flush: 'post' },
)

watch(
  tocItems,
  () => {
    activeHeadingId.value = tocItems.value[0]?.id || ''
  },
  { immediate: true },
)

watch(
  () => route.hash,
  async (value) => {
    if (!value) return
    await nextTick()
    activeHeadingId.value = value.replace(/^#/, '')
  },
)

if (typeof window !== 'undefined') {
  window.addEventListener('scroll', updateActiveHeading, { passive: true })
}

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('scroll', updateActiveHeading)
  }
})
</script>

<template>
  <section class="card content-column">
    <div class="post-layout">
      <article class="post-article">
        <button
          v-if="tocItems.length"
          class="toc-mobile-toggle"
          type="button"
          :aria-expanded="tocOpen ? 'true' : 'false'"
          @click="tocOpen = !tocOpen"
        >
          <span>目录</span>
          <span>{{ tocOpen ? '收起' : '展开' }}</span>
        </button>

        <div v-if="tocItems.length && tocOpen" class="toc-mobile-panel">
          <a
            v-for="item in tocItems"
            :key="item.id"
            class="toc-link"
            :class="[
              item.level === 3 ? 'is-child' : '',
              activeHeadingId === item.id ? 'is-active' : '',
            ]"
            :href="`#${item.id}`"
            @click="tocOpen = false"
          >
            {{ item.text }}
          </a>
        </div>

        <p v-if="isLoading" class="lead">加载中...</p>
        <div
          v-else
          ref="postBodyRef"
          class="post-content"
          v-html="renderedPost"
        ></div>
      </article>

      <aside v-if="tocItems.length" class="post-toc">
        <div class="post-toc-inner">
          <p class="post-toc-title">目录</p>
          <nav class="post-toc-nav" aria-label="文章目录">
            <a
              v-for="item in tocItems"
              :key="item.id"
              class="toc-link"
              :class="[
                item.level === 3 ? 'is-child' : '',
                activeHeadingId === item.id ? 'is-active' : '',
              ]"
              :href="`#${item.id}`"
            >
              {{ item.text }}
            </a>
          </nav>
        </div>
      </aside>
    </div>
  </section>
</template>
