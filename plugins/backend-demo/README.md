# 全栈插件示例（backend-demo）

按 [docs/PLUGIN_SPEC.md](../../docs/PLUGIN_SPEC.md) 开发的**前后端一体**插件示例：

- **后端**（`server/main.py`）：导出 `create_router(ctx) -> APIRouter`，安装时由平台进程热挂载到
  `/api/plugins/backend-demo/*`；演示 `ctx` 三项能力——平台数据库会话（`session_factory`）、
  插件私有数据目录（`data_dir`，重装保留）、独立日志（`logger`）
- **前端**（`index.html`）：从 `__ctx` 解析 `pluginApiBase` 调用自身后端 API，也可继续调平台接口

## 打包安装

```bash
zip -r backend-demo.zip manifest.json index.html server/
# 界面上传 backend-demo.zip,或放入 <数据目录>/plugins/dropins/
```

安装成功后插件管理页会显示「含后端」徽标；`GET /api/plugins/backend-demo/ping` 应返回
`{"ok": true, ...}`。卸载后路由即时摘除。

## 关键约束

- 后端插件与平台**同进程同权限**运行，属受信代码，仅管理员安装
- 依赖的第三方库必须已预装在平台环境；建议只用标准库 + FastAPI/SQLAlchemy
- 路由路径不要使用 `asset`（与静态资源端点冲突）
