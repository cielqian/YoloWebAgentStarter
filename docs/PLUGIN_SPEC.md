# YWA 插件开发规范（AI 执行版 v1.2）

> 本文档面向**AI 代理与开发者**，是开发 YWA 插件的**唯一依据**。阅读本文档后，无需查阅平台源码即可产出可被平台接受的插件包。
>
> 规范用语约定：**必须**（违反即被平台拒绝或功能不可用）、**禁止**（同上）、**建议**（不强制，但偏离可能带来体验问题）。
>
> 变更记录：v1.2 新增**后端插件**（Python，第 5 节）与 `__ctx.pluginApiBase`；v1.1 重组为 AI 可执行版。

---

## 0. 什么是 YWA 插件（一句话）

插件 = **一个自包含的 Web 应用包**（可选带 Python 后端），打成一个 zip 交给平台；平台解压后在 iframe 里打开你的入口页，页面通过 **HTTP REST** 调用平台接口或**自身后端**完成业务功能。带后端时，平台进程会加载你的 Python 路由并热挂载（见第 5 节）。

**最终交付物：一个符合第 3 节规则的 `.zip` 文件。** 不需要独立服务进程、不需要登录态。

---

## 1. 开发流程总览（按顺序执行）

1. 确定插件功能，选定一个全局唯一的 `id`（规则见 2.1）。
2. 创建工程目录（推荐结构见第 2 节）。
3. 编写 `manifest.json`（契约见 2.1，直接复制模板改）。
4. 编写入口页 `index.html`（**必须**包含 4.2 的 `__ctx` 解析样板代码）。
5. 其余 JS/CSS/图片等资源用**相对路径**引用（规则见 4.3）。
6. 调平台 REST API 时**必须**使用 `__ctx` 解析出的 `apiBase`（规则见 4.2），常用接口见第 6 节。
7. 需要后端逻辑时，按**第 5 节**编写 `server/main.py` 并在 manifest 声明 `backend`。
8. 按**第 8 节自检清单**逐条核对。
9. 按**第 7 节**打包 zip 并安装验证。

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
| `backend` | 否 | object | `{"entry": "server/main.py"}`；entry 必须是包内相对 `.py` 路径且存在 | 声明携带 Python 后端（契约见第 5 节） |
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
│   ├── assets/
│   │   ├── app.js
│   │   └── app.css
│   └── server/            # 后端源码（可选，见第 5 节）
│       └── main.py
└── dist/                  # 构建产物 = zip 根
    ├── manifest.json
    ├── index.html
    ├── assets/…
    └── server/
        └── main.py
```

原生无构建方案允许不区分 src/dist，直接把 `manifest.json` + `index.html` + 资源（含可选的 `server/`）放在同一目录打成 zip。

---

## 3. zip 包规则（平台校验，违反任一条即拒绝安装）

1. `manifest.json` **必须**位于 zip 根目录；平台也接受「zip 内只有**唯一一个**顶层目录、manifest 在其下」的形式（该层会被自动剥掉）。**禁止**出现两个及以上顶层目录。
2. **禁止**绝对路径（前导 `/`）、`..` 逃逸、反斜杠路径。路径分隔符必须是 `/`。
3. 以下杂项会被平台**静默忽略**，可携带但不影响安装也不落盘：`.git/` 目录、macOS Finder 打包产生的 `__MACOSX/` 目录、`.DS_Store`、`._*` 资源分叉文件。
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
{ "apiBase": "http://10.11.107.94:8000", "pluginId": "my-plugin", "pluginApiBase": "http://10.11.107.94:8000/api/plugins/my-plugin" }
```

- `apiBase`：平台 origin（**不含** `/api` 后缀，无尾部斜杠）。调用接口时拼接 `apiBase + "/api/..."`。
- `pluginId`：当前插件 id。
- `pluginApiBase`：本插件后端 API 的基地址（含后端的插件才有意义），拼接 `pluginApiBase + "/..."` 调用自身后端（见第 5 节）。

**禁止**硬编码平台地址；**必须**在每次启动时从 `__ctx` 解析。入口页 JS 中**必须**包含如下解析样板（可直接复制）：

```js
var context = {};
try {
  context = JSON.parse(atob(new URLSearchParams(location.search).get("__ctx") || ""));
} catch (error) { context = {}; }
var apiBase = context.apiBase || ""; // 兜底为空串 = 同源相对路径
var pluginApiBase = context.pluginApiBase || ""; // 本插件后端 API 基地址(带后端的插件用)
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

## 5. 后端插件（Python，可选）

插件包可选携带 Python 后端：安装时平台进程加载它并把返回的路由**热挂载**到
`/api/plugins/{id}/{插件路由}`，卸载/重装时原路摘除——前端与后端在同一个插件包里协同工作。

### 5.1 manifest 声明

```json
{
  "id": "my-plugin",
  "backend": { "entry": "server/main.py" }
}
```

- `backend` 整段**选填**；不写即为纯前端插件（与历史行为完全一致）。
- `backend.entry` **必须**是包内相对 `.py` 路径（**禁止** `..`、反斜杠），文件**必须**存在于包内。

### 5.2 模块契约

入口模块**必须**导出 `create_router(ctx) -> fastapi.APIRouter`，在安装时被执行：

```python
from fastapi import APIRouter

def create_router(ctx) -> APIRouter:
    router = APIRouter()

    @router.get("/ping")          # 实际路径:/api/plugins/my-plugin/ping
    def ping():
        return {"ok": True, "plugin": ctx.plugin_id}

    return router
```

安装时 `create_router` 抛错、返回非 `APIRouter`、或模块有语法错误 → **安装整体失败并回滚**（422 `plugin_backend_invalid`）。

### 5.3 `ctx`（PluginContext，后端可用能力的全部边界）

| 属性 | 类型 | 说明 |
|---|---|---|
| `plugin_id` / `name` / `version` | str | 来自 manifest |
| `data_dir` | Path | 插件**私有数据目录**（`<数据目录>/plugins-data/<id>`），跨请求持久；重装保留、卸载后残留（不会随插件目录删除） |
| `engine` | sqlalchemy Engine | 平台数据库引擎（当前 PostgreSQL） |
| `session_factory` | sessionmaker | 平台数据库会话工厂，`with ctx.session_factory() as session:` |
| `logger` | Logger | 独立日志器 `ywa.plugin.<id>`，进平台日志 |

**必须**用 `ctx.session_factory()` 访问平台数据（表结构以平台模型为准）；**禁止**自建数据库连接或写平台管理目录之外的位置（插件自己的 `data_dir` 除外）。

### 5.4 生命周期与限制（必须了解）

- **热挂载/热摘除**：安装即挂载、卸载即摘除、同 id 重装即热升级，**无需重启平台**。
- 平台**重启**时会自动重新加载所有已装插件的后端；单个插件加载失败只记日志跳过，不影响平台启动。
- **信任模型**：后端插件与平台**同进程同权限**运行，等同平台自身代码——仅限管理员安装（与上传权限一致），**不要**安装不受信任来源的插件。
- **依赖**：只能使用平台环境已预装的库（标准库、FastAPI、SQLAlchemy、Pydantic 等平台自带）；插件**不能**自带或触发安装第三方依赖。
- **路径与 id 保留字（平台强制校验，违反即拒绝安装）**：插件路由**禁止**使用 `asset` 开头的路径（静态资源端点）和空路径 `""`（与 `/api/plugins/{id}` 管理端点重叠）；后端插件 id **禁止**为 `dropins`。不同插件之间不会冲突——所有路由都强制挂在自己的 `/api/plugins/{id}/` 前缀下。
- 兄弟模块：入口同目录的 `.py` 可直接 `import`；多插件间同名模块可能冲突，**建议**给辅助模块加插件前缀。
- 长耗时/阻塞请求会占住平台工作线程——批量任务请分页或异步化。

---

## 6. 平台 REST API

### 6.1 插件管理接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugins` | 已安装插件列表（`items`，含 `has_backend`）与 dropins 目录路径（`dropins_dir`） |
| POST | `/api/plugins/install` | multipart 上传 zip 安装（字段名 `file`） |
| POST | `/api/plugins/dropins/scan` | 立即扫描 dropins 目录 |
| DELETE | `/api/plugins/{id}` | 卸载插件 |
| GET | `/api/plugins/{id}/asset/{path}` | 插件静态资源（宿主内部使用，插件一般无需调用） |

带后端的插件：**自身 API 走 `/api/plugins/{id}/{插件路由}`**，前端用 `__ctx.pluginApiBase` 拼接（见第 5 节），同样无跨域。

### 6.2 常用业务接口（供插件读取平台数据）

| 方法 | 路径 | 返回要点 |
|---|---|---|
| GET | `/api/system/health` | 平台健康检查 |
| GET | `/api/datasets` | 数据集列表（`id`、`name`、`task_type`、`image_count`、`class_count`…） |
| GET | `/api/datasets/{dataset_id}/split-counts` | train/val/test 划分计数 |
| GET | `/api/training/tasks` | 训练任务列表 `{ items: [...] }`，字段含 `id/name/status/task_type/model_name/device/node_id/epochs/progress_epoch/progress_total_epochs/progress_percent/metrics_json/error_message/created_at/updated_at`；`status` 取值 `pending/dispatching/running/completed/failed/stopped`；`metrics_json` 为扁平对象，常用键 `map50`、`map50_95`、`precision`、`recall`、`loss`、`elapsed_seconds` |
| GET | `/api/training/nodes` | 训练节点及在线状态 |

以上为只读示例；平台其余接口（写操作）也可调用，但**建议**插件优先做只读展示类功能，写操作需自担后果。

---

## 7. 安装、升级与卸载

1. **dropins 自动装载（推荐）**：把 zip 放到 `<数据目录>/plugins/dropins/`，服务启动时或「插件管理 → 扫描 dropins」时自动安装；dropins 目录内容变化（mtime 改变）后再次扫描即增量安装。
2. **界面上传**：插件管理页 → 安装插件包（.zip）。
3. **升级**：用相同 `id` 重新安装（上传或替换 dropins 中的 zip 后扫描）即整体覆盖旧版。
4. **卸载**：插件管理页对应条目 → 卸载（删除解压目录，不影响 dropins 中的 zip）。
5. 安装成功后，插件出现在主界面左侧「扩展」分组菜单，点击即在右侧 iframe 打开。

---

## 8. 交付前自检清单（逐条核对，全部通过才交付）

- [ ] zip 解开后 `manifest.json` 位于根目录（或唯一顶层目录之下）。
- [ ] `manifest.json` 为 UTF-8 合法 JSON，必填字段齐全。
- [ ] `id` 匹配 `^[a-z0-9][a-z0-9-]{1,63}$`；`version` 形如 `x.y.z`（可带预发布后缀）。
- [ ] `entry` 文件存在于包内；页面引用的所有资源都存在于包内且用相对路径。
- [ ] 声明了 `backend` 时：入口 `.py` 存在于包内、模块导出 `create_router(ctx) -> APIRouter`、路由路径不以 `asset` 开头、只使用平台已预装的库、数据只写 `ctx.data_dir`。
- [ ] 包内无绝对路径、无 `..`、无反斜杠路径分隔。
- [ ] zip ≤ 200MB、解压总量 ≤ 200MB、单文件 ≤ 64MB、文件数 ≤ 4000。
- [ ] 入口页包含 4.2 的 `__ctx` 解析样板；所有接口调用基于解析出的 `apiBase` / `pluginApiBase`，无硬编码地址。
- [ ] 忽略 `__v` 查询参数。
- [ ] 无认证头/登录逻辑（平台无登录态）。
- [ ] `html, body` 占满容器（height:100%; margin:0），宽高自适应，内容溢出可滚动。
- [ ] 对接口失败有兜底展示（错误信息可见，不是白屏）。
- [ ] 所有文本文件 UTF-8 编码；HTML 含 `<meta charset="utf-8" />`。

---

## 9. 最小可运行模板（可直接复制后修改）

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

**后端最小模板**（在上方前端模板基础上加一个文件 + manifest 一段即成全栈插件）

manifest.json 增加一段：

```json
"backend": { "entry": "server/main.py" }
```

server/main.py：

```python
from fastapi import APIRouter
from sqlalchemy import text


def create_router(ctx) -> APIRouter:
    router = APIRouter()

    @router.get("/ping")  # 实际路径:{pluginApiBase}/ping
    def ping():
        return {"ok": True, "plugin": ctx.plugin_id}

    @router.get("/datasets-count")
    def datasets_count():
        with ctx.session_factory() as session:
            return {"count": session.execute(text("SELECT COUNT(*) FROM datasets")).scalar()}

    return router
```

前端把 `api("/api/system/health")` 换成 `fetch(pluginApiBase + "/ping")` 即完成联调。

---

## 10. 仓库内参考实现

| 目录 | 定位 | 适合参考的部分 |
|---|---|---|
| `plugins/hello-demo/` | 最小可运行示例 | 单文件结构、`__ctx` 解析、健康检查调用 |
| `plugins/backend-demo/` | **前后端一体示例** | manifest `backend` 声明、`create_router(ctx)` 契约、`ctx` 三件套（数据库会话/私有数据目录/日志）、`pluginApiBase` 前后端联调 |
| `plugins/training-dashboard/` | 完整前端工程示例 | 推荐工程结构（src/dist 分离 + npm build/pack 脚本）、多文件 assets 拆分、轮询业务接口、统计卡片/进度条 UI、加载/空/错误状态、15s 自动刷新 |
