# Hax 的小窝

一个人的小窝，随手记点想法。

## 项目简介

这是一个基于 Vue 3 + Vite 构建的静态博客系统，专注于简洁的阅读体验和舒适的写作环境。

### 特性

- 📝 **Markdown 支持** - 使用 Markdown 编写文章，支持代码高亮和数学公式
- 🏷️ **分类管理** - 文章按分类组织，方便浏览
- 🔍 **简洁界面** - 清爽的设计，专注于内容阅读
- ⚡ **快速加载** - 基于 Vite 构建，极速加载体验
- 🌐 **去中心化托管** - 使用 PinMe (IPFS) 进行托管，数据永久保存

## 技术栈

- **前端框架**: Vue 3 + Vue Router
- **构建工具**: Vite
- **样式**: 原生 CSS
- **Markdown 渲染**: markdown-it + highlight.js + KaTeX
- **托管**: PinMe (IPFS)

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 预览生产构建
npm run preview
```

## 部署

本项目使用 [PinMe](https://pinme.eth.limo) 进行去中心化托管。

```bash
# 一键构建并部署
npm run deploy
```

部署后会输出 IPFS 访问链接。

### 手动部署

1. 构建项目
   ```bash
   npm run build
   ```

2. 上传到 PinMe
   ```bash
   npx pinme upload dist
   ```

## 项目结构

```
myblog/
├── content/          # Markdown 文章目录
│   └── 禅/           # 分类目录
├── public/           # 静态资源
├── src/              # 源码
│   ├── assets/       # 资源文件
│   ├── components/   # 组件
│   ├── views/        # 页面视图
│   ├── App.vue       # 根组件
│   ├── main.js       # 入口文件
│   ├── router.js     # 路由配置
│   └── style.css     # 全局样式
├── index.html        # HTML 模板
├── package.json      # 项目配置
└── vite.config.js    # Vite 配置
```

## 内容管理

- 文章存放在 `content/` 目录下
- 支持多级分类，使用文件夹组织
- 在 `content/post-meta.json` 中配置文章头图等元数据
- 在 `content/tags.json` 中配置标签

## 访问地址

- **PinMe**: https://pinme.eth.limo/#/preview/...

## 许可证

MIT
