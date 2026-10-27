# YWA 插件开发规范(v1)

插件是一个**自包含的静态 Web 应用**（任意技术栈构建），打包为 zip 后由平台自动解压装载，在主界面左侧「扩展」分组出现菜单，点击后在右侧以 iframe 打开插件界面。

## 1. 工程目录规范

推荐工程结构（源码与产物分离，**打 zip 的是 dist 内容**）：

```
my-plugin/
├── manifest.json          # 插件清单(必需,打包时放入 dist 根)
├── package.json           # 仅开发期需要,不参与运行
├── src/                   # 源码(任意框架: Vue/React/原生…)
│   ├── index.html
│   ├── main.js
│   └── ...
└── dist/                  # 构建产物 = zip 根
    ├── manifest.json
    ├── index.html
    ├── assets/
    │   ├── app.js
    │   └── app.css
    └── ...
```

## 2. manifest.json 契约

```json
{
  "id": "hello-demo",            // 必填。^[a-z0-9][a-z0-9-]{1,63}$，全局唯一，同名安装=覆盖升级
  "name": "Hello 示例插件",       // 必填。≤100 字符，显示在扩展区菜单
  "version": "1.0.0",            // 必填。语义化版本号 x.y.z[-prerelease]
  "entry": "index.html",         // 入口页面，zip 内相对路径，默认 index.html
  "description": "一句话描述",    // 选填
  "author": "team-x",           // 选填
  "icon": "🧩"                   // 选填。emoji，作为菜单图标
}
```

## 3. zip 包规则

- `manifest.json` 必须位于 zip 根目录，或唯一一个顶层目录之下（平台会自动剥掉该层）
- 禁止绝对路径、`..` 逃逸、反斜杠路径；`.git/` 会被忽略
- 单文件 ≤ 64MB，文件数 ≤ 4000，解压总量 ≤ 200MB，zip 本体 ≤ 200MB
- 所有文本文件 UTF-8 编码
- `entry` 指向的文件必须存在于包内

## 4. 运行时契约

- 平台通过 iframe 加载 `entry`，并附加查询参数 `__ctx=<base64(JSON)>`：
  ```json
  { "apiBase": "http://10.11.107.94:8000", "pluginId": "hello-demo" }
  ```
  插件应从中解析 `apiBase` 后拼 URL 调用平台 REST 接口（当前平台无登录态，直接 fetch）
- iframe 带 `sandbox="allow-scripts allow-forms allow-same-origin allow-popups"`
- 静态资源由平台按需服务：`GET /api/plugins/{id}/asset/{相对路径}`
- 插件界面占满右侧内容区，请自适应宽高

## 5. 安装方式

1. **dropins 目录自动装载**（推荐）：把 zip 放到 `<数据目录>/plugins/dropins/`，服务启动时或点击「插件管理 → 扫描 dropins」自动安装；列表刷新也会触发增量扫描
2. **界面上传**：插件管理页 → 安装插件包（.zip）
3. 卸载：插件管理页对应条目 → 卸载

## 6. 平台插件 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugins` | 已安装列表 + dropins 目录路径 |
| POST | `/api/plugins/install` | multipart 上传 zip 安装 |
| POST | `/api/plugins/dropins/scan` | 立即扫描 dropins |
| DELETE | `/api/plugins/{id}` | 卸载 |
| GET | `/api/plugins/{id}/asset/{path}` | 静态资源服务 |

## 7. 示例

仓库内 `plugins/hello-demo/` 是最小可运行示例（原生 HTML/JS）：读取 `__ctx` 上下文并调用 `/api/system/health`。把该目录内容（含 manifest.json）打成 zip 即可安装。
