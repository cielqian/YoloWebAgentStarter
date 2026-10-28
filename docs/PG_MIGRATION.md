# PostgreSQL 部署与 SQLite 平滑迁移手册

管理端默认使用数据卷内 SQLite(`/app/data/yolowebagent-starter.db`)。从 2026-10-28 起支持切换到 PostgreSQL(实测瀚高安全版 V4.5.7,PG 12 内核),切换由 `YWA_DATABASE_URL` 环境变量驱动,**不设置即回落 SQLite**,两种模式共用同一套 Alembic 迁移与模型。

## 1. 前置:建库(需要 DBA 权限)

普通业务账号(如 `hguser`)通常没有建库权限,需要管理员执行一次:

```sql
CREATE DATABASE label_stater OWNER hguser ENCODING 'UTF8';
```

连接串(密码特殊字符需 URL 转义,`@` → `%40`):

```
postgresql+psycopg2://hguser:Hgser%40123dps@10.12.42.121:8101/label_stater
```

## 2. 存量数据平滑升级(现场服务器)

前提:新版镜像已构建、`docker load` 到服务器(包含 psycopg2 依赖与迁移脚本)。

```bash
sudo bash scripts/upgrade-to-pg.sh 'postgresql+psycopg2://hguser:Hgser%40123dps@10.12.42.121:8101/label_stater'
```

脚本自动执行:

| 步骤 | 动作 | 失败行为 |
|---|---|---|
| 0-1 | 预检镜像、数据卷、PG 连通性 | 中止,服务不受影响 |
| 2 | 备份 SQLite 到 `/opt/goldwind/yolo/yolowebagent-starter.db.bak-<时间戳>` | 中止 |
| 3 | 停止 backend 容器(前端保持运行) | — |
| 4 | 迁移:alembic 建表 → 单事务拷贝全部数据(自引用外键按拓扑序) → 逐表行数校验 | 整体回滚,SQLite 未被改动 |
| 5 | 写入 `.env` 的 `YWA_DATABASE_URL`,重启 backend | — |
| 6 | 健康检查(30 次 × 2s) | **自动回滚**到 SQLite 并重启 |

**回滚**:`.env` 删除 `YWA_DATABASE_URL` 一行后 `docker-compose up -d backend` 即恢复 SQLite(迁移全程对源库只读)。重跑升级脚本前如需重新同步数据,追加 `--truncate` 参数(会清空目标库业务表后重新拷贝)。

## 3. 全新部署直接用 PG

不做数据迁移,只需在 compose 环境里设置 `YWA_DATABASE_URL`(应用启动时会自动执行 Alembic 建表):

```bash
# /opt/goldwind/yolo/.env
YWA_DATABASE_URL=postgresql+psycopg2://hguser:Hgser%40123dps@10.12.42.121:8101/label_stater
```

## 4. 迁移工具单独使用

```bash
python backend/scripts/migrate_sqlite_to_pg.py \
  --sqlite-url sqlite:///data/yolowebagent-starter.db \
  --pg-url postgresql+psycopg2://user:pass@host:port/db \
  [--truncate] [--skip-schema] [--batch-size 2000]
```

约束:源库 Alembic 版本必须与代码 head 一致(旧版本请先用应用在 SQLite 上升级);目标库业务表必须为空(或 `--truncate`);全程源库只读。

## 5. 已处理的 PostgreSQL 兼容性问题(开发参考)

| 问题 | 修复 |
|---|---|
| 迁移 0002 布尔列 `server_default=sa.text("0")`,PG 拒绝整数默认值 | 改为 `sa.false()`(SQLite 渲染仍为 0) |
| 迁移 0004/0026/0029/0030 `recreate="always"` 整表重建,PG 上被外键依赖挡住 | 按方言决定:SQLite 重建 / PG 直接 ALTER |
| Alembic 硬编码 `alembic_version.version_num VARCHAR(32)`,33 字符的 revision id 写入失败 | 启动迁移前预建加宽到 VARCHAR(255) 的版本表(`app/core/migrations.py`) |
| `model_versions.id` 声明 String(64),长血缘链 id 实际 69 字符(SQLite 不校验) | 迁移 0035 加宽到 String(128),含全部外键引用列 |

新增迁移请保持两方言兼容:布尔默认值用 `sa.true()/sa.false()`,批量改表用 `recreate="always" if sqlite else "auto"` 模式,revision id 控制在 32 字符内。
