<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import manifest from '../assets/subtitles/manifest.json'

const route = useRoute()
const slug = computed(() => route.params.slug)
const meta = computed(() => manifest.find(m => m.slug === slug.value))

const episodes = ref([])
const loading = ref(true)

watch(slug, async (val) => {
  loading.value = true
  try {
    const mod = await import(`../assets/subtitles/${val}/index.json`)
    episodes.value = mod.default.episodes
  } catch {
    episodes.value = []
  }
  loading.value = false
}, { immediate: true })
</script>

<template>
  <div class="sbs-page" v-if="meta && !loading">
    <div class="sbs-nav-top">
      <router-link to="/subtitles" class="sbs-back">← 影视学英语</router-link>
    </div>

    <header class="sbs-header">
      <h1 class="sbs-title">{{ meta.title }}</h1>
      <p class="sbs-sub">{{ meta.subtitle }} · {{ meta.episodeCount }} 集 · {{ meta.total }} 条字幕</p>
    </header>

    <section class="sbs-ep-grid">
      <router-link
        v-for="ep in episodes"
        :key="ep.episode"
        :to="`/subtitles/${slug}/${String(ep.episode).padStart(2, '0')}`"
        class="sbs-ep-card"
      >
        <div class="sbs-ep-number">EP{{ String(ep.episode).padStart(2, '0') }}</div>
        <div class="sbs-ep-body">
          <h3 class="sbs-ep-title">{{ ep.title }}</h3>
          <span class="sbs-ep-count">{{ ep.count }} 条字幕</span>
        </div>
        <span class="sbs-ep-arrow">→</span>
      </router-link>
    </section>
  </div>

  <div class="sbs-page" v-else-if="!meta && !loading">
    <p class="sbs-empty">未找到该剧集</p>
    <router-link to="/subtitles" class="sbs-back">← 影视学英语</router-link>
  </div>

  <div class="sbs-page" v-else>
    <p class="sbs-loading">加载中…</p>
  </div>
</template>

<style scoped>
.sbs-page { padding: 4px 0 40px; }

.sbs-nav-top {
  margin-bottom: 20px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}

.sbs-back {
  color: var(--accent);
  text-decoration: none;
  font-size: 0.85rem;
  font-weight: 500;
  transition: opacity 0.2s;
}

.sbs-back:hover { opacity: 0.7; }

.sbs-header { margin-bottom: 28px; }

.sbs-title {
  font-size: clamp(1.6rem, 3vw, 2.4rem);
  font-weight: 700;
  color: var(--text-strong);
  margin-bottom: 4px;
}

.sbs-sub { font-size: 0.9rem; color: var(--muted); }

.sbs-ep-grid { display: grid; gap: 10px; }

.sbs-ep-card {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 16px;
  align-items: center;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 16px 20px;
  text-decoration: none;
  color: inherit;
  transition: background 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
  box-shadow: var(--shadow);
}

.sbs-ep-card:hover {
  background: transparent;
  transform: translateY(-2px);
  box-shadow: 0 20px 48px rgba(31, 42, 40, 0.12);
}

.sbs-ep-number {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 6px 10px;
  border-radius: 10px;
  text-align: center;
  min-width: 52px;
}

.sbs-ep-body { min-width: 0; }

.sbs-ep-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-strong);
  margin-bottom: 2px;
}

.sbs-ep-count { font-size: 0.78rem; color: var(--muted); }

.sbs-ep-arrow {
  font-size: 1.1rem;
  color: var(--muted);
  transition: transform 0.2s ease;
}

.sbs-ep-card:hover .sbs-ep-arrow {
  color: var(--accent);
  transform: translateX(4px);
}

.sbs-empty, .sbs-loading {
  text-align: center;
  color: var(--muted);
  padding: 60px 0;
}

@media (max-width: 600px) {
  .sbs-ep-card { padding: 14px 16px; gap: 12px; }
}
</style>
