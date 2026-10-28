#!/usr/bin/env bash
# SQLite → PostgreSQL 平滑升级脚本(在现场服务器上执行)。
#
# 前置条件:
#   1. 新版镜像已构建并 docker load 到本机(含 psycopg2 与迁移脚本)。
#   2. 目标 PG 库已建好且账号可写(本脚本不建库)。
#   3. 以能执行 docker 的用户运行(sudo)。
#
# 用法:
#   sudo bash upgrade-to-pg.sh 'postgresql+psycopg2://hguser:Hgser%40123dps@10.12.42.123:8101/label_starter' [--truncate]
#
# 流程:备份 SQLite → 停后端 → 源库 schema 升到当前版本 → 建表+拷数据+行数校验
#       → 写 .env 切库 → 重启+健康检查。
# 任何一步失败:PG 迁移是单事务可整体回滚;切库后健康检查失败则自动回退 SQLite
# (原 SQLite 文件全程保留,删掉 .env 里的 YWA_DATABASE_URL 即恢复)。
set -euo pipefail

PG_URL="${1:?用法: sudo bash upgrade-to-pg.sh <PG_URL> [--truncate]}"
shift || true
EXTRA_ARGS=("$@")

APP_DIR="/opt/goldwind/yolo"
DB_NAME="yolowebagent-starter.db"
STAMP="$(date +%Y%m%d-%H%M%S)"
IMAGE="yolowebagent-starter-backend:latest"

cd "$APP_DIR"
if command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"; else COMPOSE="docker compose"; fi

step() { printf '\n\033[1;32m== %s\033[0m\n' "$*"; }

step "0/7 预检:镜像与数据卷"
docker image inspect "$IMAGE" >/dev/null || { echo "镜像 $IMAGE 不存在,请先部署新版镜像"; exit 1; }
VOLUME="$(docker volume ls --format '{{.Name}}' | grep -E 'ywa-data$' | head -1)"
[ -n "$VOLUME" ] || { echo "找不到 ywa-data 数据卷"; exit 1; }
echo "数据卷: $VOLUME"

step "1/7 预检:PG 连通性"
$COMPOSE run --rm --no-deps -e PG_URL="$PG_URL" backend \
  python -c "import psycopg2, os; psycopg2.connect(os.environ['PG_URL']); print('PG 可连通')"

step "2/7 备份 SQLite(只读拷贝)"
BACKUP="$APP_DIR/${DB_NAME}.bak-$STAMP"
docker run --rm -v "$VOLUME:/data" -v "$APP_DIR:/backup" "$IMAGE" \
  sh -c "cp -a /data/$DB_NAME /backup/$(basename "$BACKUP"); [ -f /data/$DB_NAME-wal ] && cp -a /data/$DB_NAME-wal /backup/ 2>/dev/null || true"
ls -lh "$BACKUP" || { echo "备份失败,中止"; exit 1; }
echo "回滚兜底:该备份 + 删除 .env 中 YWA_DATABASE_URL 即可恢复 SQLite"

step "3/7 停止后端(前端保持运行,期间接口短暂不可用)"
$COMPOSE stop backend

step "4/7 源 SQLite schema 升级到当前版本"
$COMPOSE run --rm --no-deps backend python -c \
  "from pathlib import Path; from app.core.migrations import upgrade_database; upgrade_database(Path('/app/backend'), 'sqlite:////app/data/$DB_NAME'); print('源库 schema 已升级')"

step "5/7 迁移:建 schema + 拷贝数据 + 行数校验(源库只读)"
$COMPOSE run --rm --no-deps backend python /app/backend/scripts/migrate_sqlite_to_pg.py \
  --sqlite-url "sqlite:////app/data/$DB_NAME" \
  --pg-url "$PG_URL" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}

step "6/7 切换数据库地址并重启"
touch .env
grep -v '^YWA_DATABASE_URL=' .env > .env.tmp || true
echo "YWA_DATABASE_URL=$PG_URL" >> .env.tmp
mv .env.tmp .env
$COMPOSE up -d backend

step "7/7 健康检查"
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8000/api/system/health >/dev/null 2>&1; then
    echo "升级完成:后端已运行在 PostgreSQL 上 ✓"
    $COMPOSE ps
    exit 0
  fi
  sleep 2
done

echo "健康检查失败,自动回滚到 SQLite …"
grep -v '^YWA_DATABASE_URL=' .env > .env.tmp || true
mv .env.tmp .env
$COMPOSE up -d backend
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:8000/api/system/health >/dev/null 2>&1 && { echo "已回滚到 SQLite ✓(排查 PG 端问题后可重跑本脚本)"; exit 1; }
  sleep 2
done
echo "回滚后仍未恢复健康,请人工检查:docker logs yolo-backend-1"
exit 1
