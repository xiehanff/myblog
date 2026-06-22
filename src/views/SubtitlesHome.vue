<script setup>
import manifest from '../assets/subtitles/manifest.json'
</script>

<template>
  <div class="sub-page">
    <header class="sub-header">
      <h1 class="sub-header-title">影视学英语</h1>
      <p class="sub-header-desc">逐句中英对照 · 单词精讲</p>
    </header>

    <section class="sub-grid">
      <router-link
        v-for="series in manifest"
        :key="series.slug"
        :to="`/subtitles/${series.slug}`"
        class="sub-card"
      >
        <div class="sub-card-top">
          <h2 class="sub-card-title">{{ series.title }}</h2>
          <span class="sub-card-badge">{{ series.subtitle }}</span>
        </div>
        <p class="sub-card-meta">
          {{ series.episodeCount }} 集 · {{ series.total }} 条字幕
        </p>
      </router-link>
    </section>
  </div>
</template>

<style scoped>
.sub-page {
  padding: 12px 0 40px;
}

.sub-header {
  text-align: center;
  padding: 32px 0 28px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 32px;
}

.sub-header-title {
  font-size: clamp(1.6rem, 3vw, 2.2rem);
  font-weight: 700;
  color: var(--text-strong);
  margin-bottom: 6px;
}

.sub-header-desc {
  color: var(--muted);
  font-size: 0.9rem;
}

.sub-grid {
  display: grid;
  gap: 12px;
}

.sub-card {
  display: block;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 20px 22px;
  text-decoration: none;
  color: inherit;
  transition: background 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
  box-shadow: var(--shadow);
}

.sub-card:hover {
  background: transparent;
  transform: translateY(-2px);
  box-shadow: 0 20px 48px rgba(31, 42, 40, 0.12);
}

.sub-card-top {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}

.sub-card-title {
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--text-strong);
}

.sub-card-badge {
  font-size: 0.72rem;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 2px 10px;
  border-radius: 999px;
}

.sub-card-meta {
  font-size: 0.82rem;
  color: var(--muted);
}
</style>
