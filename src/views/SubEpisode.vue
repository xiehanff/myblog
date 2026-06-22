<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import manifest from '../assets/subtitles/manifest.json'

const route = useRoute()
const slug = computed(() => route.params.slug)
const epLabel = computed(() => route.params.ep)
const epNum = computed(() => parseInt(epLabel.value))

const meta = computed(() => manifest.find(m => m.slug === slug.value))
const dialogues = ref([])
const vocabulary = ref({})
const loading = ref(true)
const expanded = ref(new Set())

watch([slug, epLabel], async () => {
  loading.value = true
  expanded.value = new Set()
  try {
    const [epMod, vocMod] = await Promise.allSettled([
      import(`../assets/subtitles/${slug.value}/ep-${epLabel.value}.json`),
      import(`../assets/subtitles/${slug.value}/vocabulary.json`),
    ])
    dialogues.value = epMod.status === 'fulfilled'
      ? epMod.value.default.dialogues.map((d, i) => ({ ...d, index: i }))
      : []
    vocabulary.value = vocMod.status === 'fulfilled' ? vocMod.value.default : {}
  } catch {
    dialogues.value = []
  }
  loading.value = false
}, { immediate: true })

const prevEp = computed(() => {
  const n = epNum.value
  return n > 1 ? String(n - 1).padStart(2, '0') : null
})
const nextEp = computed(() => {
  const n = epNum.value
  return meta.value && n < meta.value.episodeCount ? String(n + 1).padStart(2, '0') : null
})

function toggleItem(index) {
  const s = new Set(expanded.value)
  if (s.has(index)) {
    s.delete(index)
  } else {
    s.add(index)
  }
  expanded.value = s
}

function getWords(en) {
  if (!en) return []
  const tokens = en.toLowerCase().match(/\b[a-z]+(?:'[a-z]+)?\b/g) || []
  const unique = [...new Set(tokens)]
  return unique.map(w => {
    const match = en.match(new RegExp(`\\b${w.replace(/'/g, "\\'")}(?:'[a-z]+)?\\b`, 'i'))
    return {
      word: w,
      original: match?.[0] || w,
      vocab: vocabulary.value[w] || null,
    }
  })
}

const selectedWord = ref(null)
function showWord(entry) {
  selectedWord.value = selectedWord.value?.word === entry?.word ? null : entry
}
</script>

<template>
  <div class="sube-page" v-if="meta && !loading">
    <div class="sube-nav-top">
      <router-link :to="`/subtitles/${slug}`" class="sube-back">← {{ meta.title }}</router-link>
      <div class="sube-ep-nav">
        <router-link
          v-if="prevEp"
          :to="`/subtitles/${slug}/${prevEp}`"
          class="sube-nav-btn"
        >← EP{{ prevEp }}</router-link>
        <span v-else class="sube-nav-btn sube-nav-disabled">← 上一集</span>
        <router-link
          v-if="nextEp"
          :to="`/subtitles/${slug}/${nextEp}`"
          class="sube-nav-btn"
        >EP{{ nextEp }} →</router-link>
        <span v-else class="sube-nav-btn sube-nav-disabled">下一集 →</span>
      </div>
    </div>

    <header class="sube-header">
      <span class="sube-badge">EP{{ epLabel }}</span>
      <h1 class="sube-title">{{ meta.title }}</h1>
      <p class="sube-count">共 {{ dialogues.length }} 条字幕 · 点击条目展开单词精讲</p>
    </header>

    <div class="sube-list">
      <div
        v-for="d in dialogues"
        :key="d.index"
        class="sube-item"
        :class="{ 'sube-item-expanded': expanded.has(d.index) }"
      >
        <button
          class="sube-item-btn"
          @click="toggleItem(d.index)"
          :aria-expanded="expanded.has(d.index) ? 'true' : 'false'"
        >
          <span class="sube-idx">{{ d.index + 1 }}</span>
          <div class="sube-text">
            <p class="sube-en">{{ d.en || '…' }}</p>
            <p class="sube-cn">{{ d.cn || '…' }}</p>
          </div>
          <span class="sube-caret" :class="{ 'is-open': expanded.has(d.index) }">+</span>
        </button>

        <div class="sube-detail" v-if="expanded.has(d.index)">
          <div class="sube-detail-inner">
            <div class="sube-detail-text">
              <div class="sube-detail-en">{{ d.en }}</div>
              <div class="sube-detail-cn">{{ d.cn }}</div>
            </div>

            <div class="sube-detail-vocab">
              <h4 class="sube-vocab-title">单词精讲</h4>
              <template v-if="getWords(d.en).filter(w => w.vocab).length">
                <div
                  v-for="entry in getWords(d.en).filter(w => w.vocab)"
                  :key="entry.word"
                  class="sube-vocab-item"
                  @click="showWord(entry)"
                >
                  <div class="sube-vocab-head">
                    <span class="sube-vocab-word">{{ entry.original }}</span>
                    <span class="sube-vocab-phonetic">{{ entry.vocab.phonetic }}</span>
                    <span class="sube-vocab-cn">{{ entry.vocab.cn }}</span>
                  </div>
                  <div class="sube-vocab-body" v-if="selectedWord?.word === entry.word">
                    <p class="sube-vocab-explanation">{{ entry.vocab.explanation }}</p>
                  </div>
                </div>
              </template>
              <p v-else class="sube-vocab-empty">本条暂未收录精讲单词</p>
            </div>

            <div class="sube-detail-words">
              <h4 class="sube-vocab-title">文中单词</h4>
              <div class="sube-word-chips">
                <span
                  v-for="entry in getWords(d.en)"
                  :key="entry.word"
                  class="sube-word-chip"
                  :class="{ 'has-vocab': entry.vocab }"
                  @click="showWord(entry)"
                >
                  {{ entry.original }}
                </span>
              </div>
              <div class="sube-word-detail" v-if="selectedWord && !selectedWord.vocab">
                <p class="sube-vocab-none">暂未收录该词的精讲</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="sube-page" v-else-if="!meta && !loading">
    <p class="sube-empty">未找到该集数据</p>
    <router-link to="/subtitles" class="sube-back">← 影视学英语</router-link>
  </div>

  <div class="sube-page" v-else>
    <p class="sube-loading">加载中…</p>
  </div>
</template>

<style scoped>
.sube-page { padding: 4px 0 40px; }

.sube-nav-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 20px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}

.sube-back {
  color: var(--accent);
  text-decoration: none;
  font-size: 0.85rem;
  font-weight: 500;
  transition: opacity 0.2s;
}
.sube-back:hover { opacity: 0.7; }

.sube-ep-nav { display: flex; gap: 8px; }

.sube-nav-btn {
  display: inline-block;
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--card);
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 0.8rem;
  text-decoration: none;
  transition: all 0.2s ease;
}

.sube-nav-btn:hover {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: var(--accent);
}

.sube-nav-disabled { opacity: 0.35; cursor: default; }

.sube-header { margin-bottom: 24px; }

.sube-badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 3px 10px;
  border-radius: 999px;
  margin-bottom: 8px;
}

.sube-title {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--text-strong);
  margin-bottom: 6px;
}

.sube-count { font-size: 0.85rem; color: var(--muted); }

.sube-list { display: grid; gap: 6px; }

.sube-item {
  border-radius: 12px;
  border: 1px solid var(--border);
  overflow: hidden;
  transition: border-color 0.2s ease;
}

.sube-item:nth-child(odd) { background: var(--card); }
.sube-item:nth-child(even) { background: var(--bg-muted); }

.sube-item:hover { border-color: var(--accent); }
.sube-item-expanded { border-color: var(--accent); }

.sube-item-btn {
  display: grid;
  grid-template-columns: 36px 1fr 24px;
  gap: 12px;
  align-items: flex-start;
  padding: 16px 16px;
  width: 100%;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: background 0.2s ease;
}

.sube-item-btn:hover { background: var(--accent-soft); }

.sube-idx {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--muted);
  background: var(--bg-soft);
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  flex: 0 0 auto;
}

.sube-text { min-width: 0; }

.sube-en {
  font-size: 1.05rem;
  line-height: 1.55;
  color: var(--text-strong);
  margin-bottom: 4px;
  font-family: system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}

.sube-cn {
  font-size: 0.95rem;
  color: var(--muted);
  line-height: 1.45;
}

.sube-caret {
  font-size: 1.2rem;
  color: var(--muted);
  margin-top: 8px;
  transition: transform 0.2s ease;
}

.sube-caret.is-open {
  transform: rotate(45deg);
  color: var(--accent);
}

/* ---- expanded detail ---- */
.sube-detail {
  border-top: 1px solid var(--border);
}

.sube-detail-inner {
  padding: 20px 18px 22px;
  display: grid;
  gap: 18px;
}

.sube-detail-text {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.sube-detail-en {
  font-size: 1.1rem;
  line-height: 1.65;
  color: var(--text-strong);
  margin-bottom: 8px;
  font-family: system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}

.sube-detail-cn {
  font-size: 1rem;
  line-height: 1.55;
  color: var(--muted);
}

.sube-vocab-title {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 8px;
}

/* vocabulary items */
.sube-vocab-item {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 4px;
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease;
}

.sube-vocab-item:hover {
  background: transparent;
  border-color: var(--accent);
}

.sube-vocab-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.sube-vocab-word {
  font-weight: 600;
  color: var(--text-strong);
  font-size: 0.9rem;
}

.sube-vocab-phonetic {
  font-size: 0.75rem;
  color: var(--muted);
  font-family: "Google Sans Mono Local", "SFMono-Regular", ui-monospace, monospace;
}

.sube-vocab-cn {
  font-size: 0.82rem;
  color: var(--accent);
  margin-left: auto;
}

.sube-vocab-body {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.sube-vocab-explanation {
  font-size: 0.82rem;
  line-height: 1.55;
  color: var(--text);
}

.sube-vocab-empty {
  font-size: 0.82rem;
  color: var(--muted);
  font-style: italic;
}

/* word chips */
.sube-word-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.sube-word-chip {
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 0.78rem;
  color: var(--muted);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all 0.2s ease;
}

.sube-word-chip:hover {
  border-color: var(--accent);
  color: var(--text-strong);
}

.sube-word-chip.has-vocab {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: transparent;
}

.sube-word-detail {
  margin-top: 8px;
}

.sube-vocab-none {
  font-size: 0.82rem;
  color: var(--muted);
  font-style: italic;
}

.sube-loading, .sube-empty {
  text-align: center;
  color: var(--muted);
  padding: 60px 0;
}

@media (max-width: 600px) {
  .sube-nav-top { flex-direction: column; align-items: flex-start; }
  .sube-vocab-head { flex-direction: column; align-items: flex-start; gap: 2px; }
  .sube-vocab-cn { margin-left: 0; }
}
</style>
