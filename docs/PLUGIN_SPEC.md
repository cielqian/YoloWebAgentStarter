# YWA 插件开发规范（AI 执行版 v1.1）

> 本文档面向**AI 代理与开发者**，是开发 YWA 插件的**唯一依据**。阅读本文档后，无需查阅平台源码即可产出可被平台接受的插件包。
>
> 规范用语约定：**必须**（违反即被平台拒绝或功能不可用）、**禁止**（同上）、**建议**（不强制，但偏离可能带来体验问题）。
>
> v1.1 仅重组文档结构使其可被 AI 直接执行，运行时契约与 v1 完全一致。

---

## 0. 什么是 YWA 插件（一句话）

插件 = **一个自包含的静态 Web 应用**，打成一个 zip 交给平台；平台解压后在你无需关心的页面里用 **iframe** 打开你的入口页，你的页面再通过 **HTTP REST** 调用平台接口完成业务功能。

**最终交付物：一个符合第 3 节规则的 `.zip` 文件。** 不需要服务端、不需要进程、不需要登录态。

---

## 1. 开发流程总览（按顺序执行）

1. 确定插件功能，选定一个全局唯一的 `id`（规则见 2.1）。
2. 创建工程目录（推荐结构见第 2 节）。
3. 编写 `manifest.json`（契约见 2.1，直接复制模板改）。
4. 编写入口页 `index.html`（**必须**包含 4.2 的 `__ctx` 解析样板代码）。
5. 其余 JS/CSS/图片等资源用**相对路径**引用（规则见 4.3）。
6. 调平台 REST API 时**必须**使用 `__ctx` 解析出的 `apiBase`（规则见 4.2），常用接口见第 5 节。
7. 按**第 7 节自检清单**逐条核对。
8. 按**第 6 节**打包 zip 并安装验证。

---

## 2. 工程结构与 manifest.json 契约

### 2.1 manifest.json 字段契约

`manifest.json` **必须**是 UTF-8 编码的合法 JSON 对象，字段如下：

| 字段 | 必填 | 类型 | 约束 | 说明 |
|---|---|---|---|---|
| `id` | 是 | string | 正则 `^[a-z0-9][a-z0-9-]{1,63}$`（即：小写字母/数字/连字符，首字符为字母或数字，总长 2-64） | 全局唯一标识；与已装插件同 id 的安装 = **覆盖升级** |
| `name` | 是 | string | 1-100 字符 | 显示在扩展区菜单 |
| `version` | 是 | string | 正则 `\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?`（如 `1.0.0`、`1.2.0-beta.1`） | 语义化版本号 |
| `entry` | 否 | string | 默认 `index.html`；必须是 zip 内相对路径，**禁止**含 `..`、反斜杠、前导 `/` | 入口页面 |
| `description` | 否 | string | ≤ 2000 字符 | 一句话描述 |
| `author` | 否 | string | ≤ 100 字符 | 作者 |
| `icon` | 否 | string | ≤ 8 字符 | emoji，作为菜单图标，如 `"📊"` |

允许出现上表之外的字段（会被忽略），但**禁止**缺少任一必填字段。

**可直接复制的合法示例：**

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "entry": "index.html",
  "description": "一句话描述这个插件做什么。",
  "author": "team-x",
  "icon": "🧩"
}
```

### 2.2 推荐工程结构

源码与产物分离，**打 zip 的是 dist 内容**（即 zip 解开后直接看到 `manifest.json` 与 `entry`）：

```
my-plugin/
├── manifest.json          # 插件清单（源；打包时复制进 dist 根）
├── src/                   # 源码，任意框架（Vue/React/原生均可）
│   ├── index.html
│   └── assets/
│       ├── app.js
│       └── app.css
└── dist/                  # 构建产物 = zip 根
    ├── manifest.json
    ├── index.html
    └── assets/…
```

原生无构建方案允许不区分 src/dist，直接把 `manifest.json` + `index.html` + 资源放在同一目录打成 zip。

---

## 3. zip 包规则（平台校验，违反任一条即拒绝安装）

1. `manifest.json` **必须**位于 zip 根目录；平台也接受「zip 内只有**唯一一个**顶层目录、manifest 在其下」的形式（该层会被自动剥掉）。**禁止**出现两个及以上顶层目录。
2. **禁止**绝对路径（前导 `/`）、`..` 逃逸、反斜杠路径。路径分隔符必须是 `/`。
3. `.git/` 目录会被静默忽略，可携带但不生效。
4. 大小与数量上限：zip 本体 ≤ **200 MB**；解压后总量 ≤ **200 MB**；单文件 ≤ **64 MB**；文件数 ≤ **4000**。
5. `manifest.json` 与所有文本文件**必须**为 UTF-8 编码。
6. `entry` 指向的文件**必须**存在于包内（按剥掉顶层目录后的相对路径判断）。
7. zip **必须**是标准 zip 格式（拒绝损坏文件）。

**打包命令**（在 dist 目录内执行，保证 zip 根 = dist 内容）：

```bash
cd dist && zip -r ../my-plugin.zip .
```

---

## 4. 运行时契约

### 4.1 加载方式与沙箱

平台以如下方式加载插件入口页：

```
<iframe src="{apiBase}/api/plugins/{id}/asset/{entry}?__ctx=<urlencoded-base64>&__v=<nonce>"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups" />
```

- 页面由平台同源服务，因此 `fetch` 平台接口**无跨域问题**。
- 沙箱已允许：脚本、表单、同源、弹窗。**没有** `allow-downloads` 等其余能力，不要依赖。
- URL 中的 `__v` 是宿主的缓存穿透参数，插件**必须忽略**它，只解析 `__ctx`。
- 插件界面会占满右侧内容区：**必须**让 `html, body { height: 100%; margin: 0; }` 并自适应宽高；内容溢出时自行处理滚动。

### 4.2 `__ctx` 宿主上下文（样板代码，必须原样包含）

宿主通过查询参数 `__ctx` 注入 base64 编码的 JSON：

```json
{ "apiBase": "http://10.11.107.94:8000", "pluginId": "my-plugin" }
```

- `apiBase`：平台 origin（**不含** `/api` 后缀，无尾部斜杠）。调用接口时拼接 `apiBase + "/api/..."`。
- `pluginId`：当前插件 id。

**禁止**硬编码平台地址；**必须**在每次启动时从 `__ctx` 解析。入口页 JS 中**必须**包含如下解析样板（可直接复制）：

```js
var context = {};
try {
  context = JSON.parse(atob(new URLSearchParams(location.search).get("__ctx") || ""));
} catch (error) { context = {}; }
var apiBase = context.apiBase || ""; // 兜底为空串 = 同源相对路径
```

调用平台接口的统一封装（**建议**使用）：

```js
function api(path, options) {
  return fetch(apiBase + path, options).then(function (response) {
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  });
}
```

平台当前无登录态，直接 `fetch` 即可，**禁止**附加任何认证头。

### 4.3 静态资源引用

- 平台按需服务插件文件：`GET /api/plugins/{id}/asset/{相对路径}`。
- 入口页与页面内资源在同一个 asset 路径下，因此 `index.html` 引用资源**必须用相对路径**（如 `assets/app.js`），**禁止**以 `/` 开头或写绝对 URL。
- 资源路径越界（含 `..`）或文件不存在返回 404；无法识别的扩展名以 `application/octet-stream` 返回。
- 平台识别的扩展名及 MIME：`.html .js .mjs .css .json .svg .png .jpg .jpeg .gif .webp .ico .woff .woff2 .ttf .map .txt .wasm`。引用其他类型文件可能无法按预期 MIME 加载，**禁止**依赖未列出类型。

---

## 5. 平台 REST API

### 5.1 插件管理接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugins` | 已安装插件列表（`items`）与 dropins 目录路径（`dropins_dir`） |
| POST | `/api/plugins/install` | multipart 上传 zip 安装（字段名 `file`） |
| POST | `/api/plugins/dropins/scan` | 立即扫描 dropins 目录 |
| DELETE | `/api/plugins/{id}` | 卸载插件 |
| GET | `/api/plugins/{id}/asset/{path}` | 插件静态资源（宿主内部使用，插件一般无需调用） |

### 5.2 常用业务接口（供插件读取平台数据）

| 方法 | 路径 | 返回要点 |
|---|---|---|
| GET | `/api/system/health` | 平台健康检查 |
| GET | `/api/datasets` | 数据集列表（`id`、`name`、`task_type`、`image_count`、`class_count`…） |
| GET | `/api/datasets/{dataset_id}/split-counts` | train/val/test 划分计数 |
| GET | `/api/training/tasks` | 训练任务列表 `{ items: [...] }`，字段含 `id/name/status/task_type/model_name/device/node_id/epochs/progress_epoch/progress_total_epochs/progress_percent/metrics_json/error_message/created_at/updated_at`；`status` 取值 `pending/dispatching/running/completed/failed/stopped`；`metrics_json` 为扁平对象，常用键 `map50`、`map50_95`、`precision`、`recall`、`loss`、`elapsed_seconds` |
| GET | `/api/training/nodes` | 训练节点及在线状态 |

以上为只读示例；平台其余接口（写操作）也可调用，但**建议**插件优先做只读展示类功能，写操作需自担后果。

---

## 6. 安装、升级与卸载

1. **dropins 自动装载（推荐）**：把 zip 放到 `<数据目录>/plugins/dropins/`，服务启动时或「插件管理 → 扫描 dropins」时自动安装；dropins 目录内容变化（mtime 改变）后再次扫描即增量安装。
2. **界面上传**：插件管理页 → 安装插件包（.zip）。
3. **升级**：用相同 `id` 重新安装（上传或替换 dropins 中的 zip 后扫描）即整体覆盖旧版。
4. **卸载**：插件管理页对应条目 → 卸载（删除解压目录，不影响 dropins 中的 zip）。
5. 安装成功后，插件出现在主界面左侧「扩展」分组菜单，点击即在右侧 iframe 打开。

---

## 7. 交付前自检清单（逐条核对，全部通过才交付）

- [ ] zip 解开后 `manifest.json` 位于根目录（或唯一顶层目录之下）。
- [ ] `manifest.json` 为 UTF-8 合法 JSON，必填字段齐全。
- [ ] `id` 匹配 `^[a-z0-9][a-z0-9-]{1,63}$`；`version` 形如 `x.y.z`（可带预发布后缀）。
- [ ] `entry` 文件存在于包内；页面引用的所有资源都存在于包内且用相对路径。
- [ ] 包内无绝对路径、无 `..`、无反斜杠路径分隔。
- [ ] zip ≤ 200MB、解压总量 ≤ 200MB、单文件 ≤ 64MB、文件数 ≤ 4000。
- [ ] 入口页包含 4.2 的 `__ctx` 解析样板；所有接口调用基于解析出的 `apiBase`，无硬编码地址。
- [ ] 忽略 `__v` 查询参数。
- [ ] 无认证头/登录逻辑（平台无登录态）。
- [ ] `html, body` 占满容器（height:100%; margin:0），宽高自适应，内容溢出可滚动。
- [ ] 对接口失败有兜底展示（错误信息可见，不是白屏）。
- [ ] 所有文本文件 UTF-8 编码；HTML 含 `<meta charset="utf-8" />`。

---

## 8. 最小可运行模板（可直接复制后修改）

**manifest.json**

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "entry": "index.html",
  "description": "演示插件规范的最小模板。",
  "author": "team-x",
  "icon": "🧩"
}
```

**index.html**

```html
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>我的插件</title>
  <style>
    html, body { height: 100%; margin: 0; }
    body { font-family: system-ui, sans-serif; padding: 24px; color: #273248; background: #f7f9ff; }
  </style>
</head>
<body>
  <h1>🧩 我的插件</h1>
  <p>apiBase: <code id="api-base">-</code> · pluginId: <code id="plugin-id">-</code></p>
  <p>平台健康检查：<span id="health">请求中…</span></p>
  <script>
    var context = {};
    try {
      context = JSON.parse(atob(new URLSearchParams(location.search).get("__ctx") || ""));
    } catch (error) { context = {}; }
    var apiBase = context.apiBase || "";
    document.getElementById("api-base").textContent = apiBase || "(未注入，同源)";
    document.getElementById("plugin-id").textContent = context.pluginId || "-";

    fetch(apiBase + "/api/system/health")
      .then(function (response) { if (!response.ok) throw new Error("HTTP " + response.status); return response.json(); })
      .then(function (data) { document.getElementById("health").textContent = JSON.stringify(data); })
      .catch(function (error) { document.getElementById("health").textContent = "请求失败：" + error.message; });
  </script>
</body>
</html>
```

把这两个文件放在同一目录，`zip -r my-plugin.zip .` 即得到可安装的插件包。

---

## 9. 仓库内参考实现

| 目录 | 定位 | 适合参考的部分 |
|---|---|---|
| `plugins/hello-demo/` | 最小可运行示例 | 单文件结构、`__ctx` 解析、健康检查调用 |
| `plugins/training-dashboard/` | 完整工程示例 | 推荐工程结构（src/dist 分离 + npm build/pack 脚本）、多文件 assets 拆分、轮询业务接口、统计卡片/进度条 UI、加载/空/错误状态、15s 自动刷新 |
