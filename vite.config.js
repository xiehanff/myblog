import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'

const contentRoot = path.resolve(process.cwd(), 'content')
const tagsFile = path.join(contentRoot, 'tags.json')
const postMetaFile = path.join(contentRoot, 'post-meta.json')

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

const walkMarkdown = (dir) => {
  if (!fs.existsSync(dir)) return []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return walkMarkdown(fullPath)
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      return [fullPath]
    }
    return []
  })
}

const buildContentIndex = () => {
  const files = walkMarkdown(contentRoot)
  let tags = {}
  let postMeta = {}
  if (fs.existsSync(tagsFile)) {
    try {
      tags = JSON.parse(fs.readFileSync(tagsFile, 'utf-8'))
    } catch (error) {
      console.error('[content-index] tags.json parse failed:', error)
    }
  }
  if (fs.existsSync(postMetaFile)) {
    try {
      postMeta = JSON.parse(fs.readFileSync(postMetaFile, 'utf-8'))
    } catch (error) {
      console.error('[content-index] post-meta.json parse failed:', error)
    }
  }

  const posts = files.map((file) => {
    const raw = fs.readFileSync(file, 'utf-8')
    const { data, body } = parseFrontmatter(raw)
    const match = body.match(/^#\\s+(.+)$/m)
    const title = data.title || (match ? match[1].trim() : path.basename(file, '.md'))
    const stats = fs.statSync(file)
    const relative = path.relative(contentRoot, file).split(path.sep).join('/')
    const categories = relative.split('/').slice(0, -1)
    const meta = postMeta[relative] || {}
    return {
      path: relative,
      title,
      date: data.date || meta.date || '',
      mtime: stats.mtimeMs,
      categories,
      cover: meta.cover || data.cover || '',
    }
  })

  return {
    posts,
    tags,
    watchFiles: [...files, tagsFile, postMetaFile],
  }
}

const contentIndexPlugin = () => {
  const virtualId = 'virtual:content-index'
  const resolvedId = `\0${virtualId}`
  return {
    name: 'content-index',
    resolveId(id) {
      if (id === virtualId) return resolvedId
      return null
    },
    load(id) {
      if (id !== resolvedId) return null
      const { posts, tags, watchFiles } = buildContentIndex()
      watchFiles.forEach((file) => {
        if (file && fs.existsSync(file)) this.addWatchFile(file)
      })
      return `export default ${JSON.stringify({ posts, tags })}`
    },
  }
}

const contentAssetsPlugin = () => {
  let outDir = 'dist'
  return {
    name: 'content-assets',
    configResolved(config) {
      outDir = config.build.outDir || 'dist'
    },
    configureServer(server) {
      server.middlewares.use('/content', (req, res, next) => {
        if (!req.url) return next()
        const [pathname, query = ''] = req.url.split('?')
        if (pathname.endsWith('.md') || /(?:^|&)raw(?:&|$)|(?:^|&)import(?:&|$)/.test(query)) {
          return next()
        }
        const decoded = decodeURIComponent(pathname).replace(/^\/+/, '')
        const filePath = path.join(contentRoot, decoded)
        if (!filePath.startsWith(contentRoot)) return next()
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          return next()
        }
        const ext = path.extname(filePath).toLowerCase()
        const contentTypes = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
        }
        res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream')
        fs.createReadStream(filePath).pipe(res)
      })
    },
    closeBundle() {
      if (!fs.existsSync(contentRoot)) return
      const target = path.join(process.cwd(), outDir, 'content')
      fs.mkdirSync(target, { recursive: true })
      fs.cpSync(contentRoot, target, { recursive: true })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: '/myblog/',
  plugins: [vue(), contentIndexPlugin(), contentAssetsPlugin()],
})
