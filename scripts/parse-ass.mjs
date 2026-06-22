import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const EPISODE_TITLES = [
  'The Heirs of the Dragon',
  'The Rogue Prince',
  'Second of His Name',
  'King of the Narrow Sea',
  'We Light the Way',
  'The Princess and the Queen',
  'Driftmark',
  'The Lord of the Tides',
  'The Green Council',
  'The Black Queen',
]

function stripAssTags(text) {
  return text.replace(/\{[^}]*\}/g, '')
}

function parseDialogueText(raw) {
  let text = raw.trim()
  text = text.replace(/\\N/g, '\n')
  text = stripAssTags(text)
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length === 0) return { cn: '', en: '' }
  if (lines.length === 1) {
    const line = lines[0].trim()
    if (/[\u4e00-\u9fff]/.test(line)) {
      return { cn: line, en: '' }
    }
    return { cn: '', en: line }
  }
  const cn = lines[0].trim()
  const en = lines.slice(1).join(' ').trim()
  return { cn, en }
}

function parseAssFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8')
  const dialogues = []

  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith('Dialogue:')) continue
    const rest = line.slice('Dialogue: '.length)
    const commaIndexes = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === ',') commaIndexes.push(i)
      if (commaIndexes.length === 9) break
    }
    if (commaIndexes.length < 9) continue

    const textField = rest.slice(commaIndexes[8] + 1).trim()
    const { cn, en } = parseDialogueText(textField)
    const cleanEn = en.replace(/[\u2013\u2014]/g, '-')
    dialogues.push({ cn, en: cleanEn })
  }

  return dialogues
}

/**
 * Usage:
 *   node scripts/parse-ass.mjs          (uses defaults: house-of-the-dragon, S01E01-E10)
 *   node scripts/parse-ass.mjs <slug>   (specify a slug for your show)
 *
 * File naming convention for ASS files:
 *   House.of.the.Dragon.S01E{NN}.xxx.zh.ass  → slug: house-of-the-dragon
 *   Or any pattern, it will extract the episode number from S{season}E{episode}
 */
function main() {
  const slug = process.argv[2] || 'house-of-the-dragon'

  // Find the ASS source directory: look for directories containing the slug pattern
  const rootEntries = fs.readdirSync(root, { withFileTypes: true })
  const assDir = rootEntries.find(e =>
    e.isDirectory() &&
    e.name.toLowerCase().includes(slug.replace(/-/g, '.'))
  )
  if (!assDir) {
    console.error(`Cannot find ASS directory matching slug "${slug}"`)
    console.error('Available directories:', rootEntries.filter(e => e.isDirectory()).map(e => e.name))
    process.exit(1)
  }

  const srcDir = path.join(root, assDir.name)
  const assFiles = fs.readdirSync(srcDir)
    .filter(f => f.endsWith('.ass'))
    .sort()

  if (assFiles.length === 0) {
    console.error(`No .ass files found in ${srcDir}`)
    process.exit(1)
  }

  const outDir = path.join(root, 'src', 'assets', 'subtitles', slug)
  fs.mkdirSync(outDir, { recursive: true })

  const episodes = []

  for (const assFile of assFiles) {
    // Extract episode number from S01E01 pattern
    const epMatch = assFile.match(/S\d+E(\d+)/i)
    if (!epMatch) {
      console.warn(`  Skipping "${assFile}": cannot extract episode number`)
      continue
    }
    const epNum = parseInt(epMatch[1])
    const epLabel = String(epNum).padStart(2, '0')

    const filePath = path.join(srcDir, assFile)
    const dialogues = parseAssFile(filePath)

    // Use provided title or fall back to episode number
    const title = EPISODE_TITLES[epNum - 1] || `Episode ${epNum}`
    const epFile = path.join(outDir, `ep-${epLabel}.json`)
    fs.writeFileSync(epFile, JSON.stringify({ episode: epNum, title, dialogues }), 'utf-8')

    episodes.push({ episode: epNum, title, count: dialogues.length })
    console.log(`  EP${epLabel} "${title}": ${dialogues.length} dialogues → ep-${epLabel}.json`)
  }

  // Write index
  const index = {
    slug,
    title: slug === 'house-of-the-dragon' ? 'House of the Dragon' : slug,
    subtitle: 'Season 1',
    total: episodes.reduce((s, e) => s + e.count, 0),
    episodes,
  }
  const indexFile = path.join(outDir, 'index.json')
  fs.writeFileSync(indexFile, JSON.stringify(index), 'utf-8')

  // Write manifest (appended or created)
  const manifestPath = path.join(root, 'src', 'assets', 'subtitles', 'manifest.json')
  let manifest = []
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      manifest = manifest.filter(e => e.slug !== slug)
    } catch { /* ignore */ }
  }
  manifest.push({ slug, title: index.title, subtitle: index.subtitle, total: index.total, episodeCount: episodes.length })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

  console.log(`\nDone! ${index.total} dialogues across ${episodes.length} episodes`)
  console.log(`Index: ${indexFile}`)
  console.log(`Data:  ${outDir}`)
}

main()
