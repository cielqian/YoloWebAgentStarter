# 训练任务看板（插件包示例）

按 [docs/PLUGIN_SPEC.md](../../docs/PLUGIN_SPEC.md) v1 规范开发的**完整示例插件**：原生 HTML/CSS/JS，无框架、无构建依赖，演示插件包的推荐工程结构与平台 API 对接方式。

## 功能

- 解析宿主注入的 `__ctx` 上下文（`apiBase` / `pluginId`）
- 轮询 `GET /api/training/tasks`，展示任务统计卡片与明细表
- 展示状态、任务类型、权重、设备/节点、epoch 进度条、mAP50 / mAP50-95 / loss（来自 `metrics_json`）
- 手动刷新 + 15s 自动刷新开关；加载 / 空 / 错误状态齐备
- 自适应宽高，占满宿主右侧内容区

## 工程结构

```
training-dashboard/
├── manifest.json          # 插件清单（打包时复制进 dist 根）
├── package.json           # 仅开发期：build/pack 脚本，不参与运行
├── README.md
├── src/                   # 源码
│   ├── index.html         # 入口页（manifest.entry）
│   └── assets/
│       ├── app.css
│       └── app.js
└── dist/                  # 构建产物 = zip 根（npm run build 生成）
    ├── manifest.json
    ├── index.html
    └── assets/…
```

## 开发与打包

```bash
npm run build    # src + manifest.json → dist/
npm run pack     # build 并生成 training-dashboard.zip（zip 根 = dist 内容）
```

无需 node 也可以直接打包：

```bash
cd src && zip -r ../training-dashboard.zip . && cd .. && zip -j training-dashboard.zip manifest.json
```

## 安装

任选其一：

1. 把 `training-dashboard.zip` 放入 `<数据目录>/plugins/dropins/`，在「插件管理 → 扫描 dropins」或重启服务后自动安装；
2. 插件管理页 → 安装插件包（.zip）上传。

## 规范要点对照

| 规范条款 | 本示例的实现 |
|---|---|
| manifest.json 契约 | 见根目录 `manifest.json`，字段与 `^[a-z0-9][a-z0-9-]{1,63}$` id 均符合 |
| zip 根 = dist 内容 | `npm run pack` 从 `dist/` 内部打包 |
| `__ctx` 解析 | `app.js` 中 `atob` + `JSON.parse`，失败时回退同源 |
| 静态资源相对路径 | `index.html` 引用 `assets/app.css` / `assets/app.js`，由平台 asset 端点按需服务 |
| UTF-8 | 全部文件 UTF-8 编码 |
| 自适应 | body 占满 iframe，表格横向滚动、表头吸顶 |
