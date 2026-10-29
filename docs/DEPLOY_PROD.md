# 生产环境发布手册（AI 执行版）

> 本文档面向 **AI 代理与运维者**，是向生产环境 10.11.107.94 发布新版本的 **唯一标准流程**。在任何机器（包括另一台电脑上的 AI）执行发布时，必须按本手册操作，禁止临场发明流程。
>
> ⚠️ **本文档包含生产服务器凭据，禁止将本仓库公开或外传。**

规范用语约定（与 PLUGIN_SPEC.md 一致）：**必须**（违反即发布失败或留下安全隐患）、**禁止**、**建议**。

---

## 0. 铁律：发布前必须先提交代码

**发布 = 代码已进 git 的版本。** 执行发布前必须：

1. `git status` 检查工作区；
2. 有未提交的功能改动 → 先按功能分 commit（中文提交信息，风格仿照 `git log`）；
3. 发布完成后向用户汇报「生产 = commit XXX」。

例外：`backend/Dockerfile`、`frontend/Dockerfile` **不提交**（本地为参数化通用版，生产用自己的增量构建版；两台机器上都应保持 skip-worktree）。

## 1. 服务器档案

| 项 | 值 |
|---|---|
| 地址 | 10.11.107.94（内网，无外网出口） |
| 账号 | admin（密码 `Goldwind@2026`，sudo 同密码） |
| 部署目录 | /opt/goldwind/yolo（docker-compose 部署） |
| 容器 | yolo-backend-1（:8000）、yolo-frontend-1（:8080） |
| 数据卷 | named volume `ywa-data`（数据库/数据，升级保留，禁止删） |
| 数据库 | **瀚高安全版 PG**（外部 10.12.42.123:8101，库 label_starter），经 `/opt/goldwind/yolo/.env` 的 `YWA_DATABASE_URL` 配置；容器启动时 Alembic 自动迁移到最新头 |
| 磁盘 | / 分区 900G，长期余量 800G+ |

## 2. 架构：增量镜像（为什么不能完整重建）

服务器 **无外网**：Docker Hub、deb.debian.org、pypi.org、download.pytorch.org 均不可达或 2KB/s。可用内网镜像：

- apt → `mirrors.huaweicloud.com`
- pip → `https://mirrors.huaweicloud.com/repository/pypi/simple`
- npm → `registry.npmmirror.com`

因此镜像采用 **底座 + 增量层** 策略。服务器上长期保留两个底座 tag：

- `yolo-backend-base`（约 2GB：python3.12 + torch/torchvision + 全部重依赖）
- `yolo-frontend-base`（nginx + 静态资源壳）

生产目录下的 Dockerfile 是增量版（**与仓库里的不一样，发布时禁止被代码包覆盖**，见流程 Step 3 的保护动作）：

```dockerfile
# /opt/goldwind/yolo/backend/Dockerfile
FROM yolo-backend-base:latest
WORKDIR /app
COPY . /app/backend
RUN pip install --no-cache-dir -r /app/backend/requirements.txt -i https://mirrors.huaweicloud.com/repository/pypi/simple
```

```dockerfile
# /opt/goldwind/yolo/frontend/Dockerfile
FROM yolo-frontend-base:latest
COPY dist-tmp /usr/share/nginx/html
```

回滚 tag 体系：每次发布前把当前运行镜像打成 `yolo-backend-prev` / `yolo-frontend-prev`，发布失败或需要回退时改 tag 即可秒级回切。另有代码备份 `~/release-backup-*.tar.gz`。

## 3. 标准发布流程

以下命令假定在本机 shell 可用 ssh 直连。Windows 无 sshpass 时，用文末附录的 paramiko 片段执行同样的命令。密码以 `PW` 代称（= 上表密码）。

### Step 1 判断发布范围

- 改动只涉及 `frontend/` → **仅发前端**（后端镜像/容器不动，最快）
- 涉及 `backend/`（含 requirements、alembic 迁移）→ 前后端都发

### Step 2 前端构建（本地）

```bash
cd frontend
VITE_API_BASE= npm run build        # API 走相对路径,经 nginx 代理
grep -c "127.0.0.1:8000" dist/assets/*.js | grep -v ":0"   # 必须无输出(无硬编码地址)
tar -czf /tmp/ywa-dist.tar.gz -C dist .
```

上传 dist 到服务器 home（**SFTP 禁止传 /tmp**，那台机器 /tmp 对 SFTP 不可写）：

```bash
scp /tmp/ywa-dist.tar.gz admin@10.11.107.94:~/
```

### Step 3（仅后端变更时）导出后端代码包

```bash
git archive HEAD backend -o /tmp/ywa-backend.tar    # 必须在仓库根目录执行
scp /tmp/ywa-backend.tar admin@10.11.107.94:~/
```

注意：`git archive` 包内含仓库版的 backend/Dockerfile，解压会覆盖服务器的增量版，**解压后必须还原**（下述命令已含）。

### Step 4 服务器端替换 + 打回滚 tag

后端变更时（含还原增量 Dockerfile 的保护动作）：

```bash
cd /opt/goldwind/yolo
echo PW | sudo -S -p '' docker tag yolowebagent-starter-backend:latest yolo-backend-prev:latest
cp backend/Dockerfile ~/inc-backend.Dockerfile          # 保住增量版
rm -rf backend && mkdir backend && tar -xf ~/ywa-backend.tar
cp ~/inc-backend.Dockerfile backend/Dockerfile          # 还原增量版
```

前端（每次发布都做）：

```bash
cd /opt/goldwind/yolo
echo PW | sudo -S -p '' docker tag yolowebagent-starter-frontend:latest yolo-frontend-prev:latest
rm -rf frontend/dist-tmp && mkdir -p frontend/dist-tmp
tar -xzf ~/ywa-dist.tar.gz -C frontend/dist-tmp
```

### Step 5 构建 + 滚动更新

```bash
cd /opt/goldwind/yolo
echo PW | sudo -S -p '' docker-compose build frontend        # 后端变更时加 backend
echo PW | sudo -S -p '' docker-compose up -d
```

- 前端构建约 0.1s（纯 COPY 层）；后端秒级，仅 requirements 有新依赖时才真下载（走华为云 pip 源）。
- **sudo 注意**：管道传密码的命令行末尾**禁止**再接 `< /dev/null` 之类重定向（会覆盖 stdin 管道导致 sudo 报「未提供密码」）。
- **构建卡死注意**：若通过 paramiko/脚本执行且构建较慢，**必须** `setsid nohup <cmd> > log 2>&1 < /dev/null &` 分离后台跑再轮询日志；前台等返回会因子进程持有 FD 永久挂起。构建脚本用完删除（含密码）。

### Step 6 验证清单（必须全绿才算发布完成）

```bash
curl -s http://127.0.0.1:8000/api/system/health                      # {"status":"ok"}
curl -s http://127.0.0.1:8000/api/system/info                        # task_types 含全部类型
curl -s http://127.0.0.1:8080/ | grep -oE 'index-[A-Za-z0-9_-]+\.js' # = 本次本地构建的 bundle 名
curl -s http://127.0.0.1:8000/api/datasets                           # 200,数据在
```

- 新 bundle 内抽查本次新特性的特征字符串（如 `curl -s .../assets/index-XXX.js | grep -c 新增文案`）。
- 发了后端：确认迁移头。**直连瀚高 PG 查询必须先打 pg_compat 补丁**（裸 SQLAlchemy 会被瀚高营销版本串 AssertionError 拒绝）：

```bash
echo PW | sudo -S -p '' docker exec yolo-backend-1 python -c \
  "import sys; sys.path.insert(0,'/app/backend'); from app.core import pg_compat; import os, sqlalchemy; \
   e=sqlalchemy.create_engine(os.environ['YWA_DATABASE_URL']); \
   print(e.connect().exec_driver_sql('select version_num from alembic_version').scalar())"
# 期望 = backend/alembic/versions 下最新版本号
```

- 外部验证：从你所在的机器 `curl http://10.11.107.94:8080/` 与 `:8000/api/system/health`。
- 服务器终端中文显示为 GBK 乱码属正常现象，不影响功能，不要试图"修复"。

### Step 7 清理（必须）

```bash
rm -f ~/ywa-dist.tar.gz ~/ywa-backend.tar ~/inc-*.Dockerfile ~/build*.sh ~/build*.log ~/build*.done
```

保留：`yolo-backend-base` / `yolo-frontend-base`（底座，**禁止删**）、`yolo-*-prev`（回滚）、`~/release-backup-*.tar.gz`（大版本备份）。

## 4. 回滚

- **镜像回滚（最快）**：`docker tag yolo-frontend-prev:latest yolowebagent-starter-frontend:latest && docker-compose up -d frontend`（backend 同理）。适合"新版本有问题，先回上个版本"。
- **代码级**：`~/release-backup-YYYYMMDD-HHMMSS.tar.gz` 是打包时刻的 backend/frontend 源码 + compose，解回 /opt/goldwind/yolo 后重建。
- 数据库迁移**不做降级**；Alembic 迁移均向后兼容（新列为 nullable/带默认），回滚镜像连旧库可正常跑。

## 5. 已知坑速查

| 症状 | 原因/处理 |
|---|---|
| sudo 报「未提供密码」 | 管道命令末尾加了重定向，去掉 `< /dev/null` |
| pip/apt 下载 0 B/s | 服务器无外网，源必须走华为云/npmmirror（Dockerfile 已内置） |
| exec 通道构建时永久挂起 | 后台构建进程持有 FD；setsid nohup 分离 + 轮询日志 |
| SFTP 上传报 ENOENT | 传 home 目录，不传 /tmp |
| 直连 PG 报 AssertionError 版本串 | 瀚高营销版本串；先 `from app.core import pg_compat` |
| 查 SQLite 发现迁移落后 | 误导：生产用瀚高 PG，卷内 SQLite 是废弃旧文件；查 PG 用 Step 6 方法 |
| 中文输出全是乱码 | 服务器终端 GBK，显示问题，忽略 |

## 附录：Windows 无 sshpass 时的执行方式

用项目 venv 里的 paramiko 写两个一次性脚本（用完删，**含密码禁止入库**），或直接让用户在本机执行 `! ssh admin@10.11.107.94`。片段：

```python
# sshx.py — python sshx.py "<远程命令>" [超时秒]
import sys, paramiko
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("10.11.107.94", username="admin", password="PW", look_for_keys=False, allow_agent=False)
_, out, err = client.exec_command(sys.argv[1], timeout=int(sys.argv[2]) if len(sys.argv) > 2 else 120)
print(out.read().decode("utf-8", "replace"), end="")
code = out.channel.recv_exit_status()
print(err.read().decode("utf-8", "replace"), file=sys.stderr)
sys.exit(code)
```

SFTP 上传同理：`sftp.put(local, "ywa-dist.tar.gz")`（目标在 home）。

---

最近一次发布：2026-10-29 08:50，生产 = main `5f44050`（全站列表垂直居中统一，仅前端）。
流程备注：Step 4 的命令经 sudo bash -c 执行时 `~` 展开为 /root，**必须**用绝对路径 `/home/admin/…` 引用上传的包。
