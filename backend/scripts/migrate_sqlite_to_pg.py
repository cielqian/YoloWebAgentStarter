"""SQLite → PostgreSQL 一次性数据迁移工具(配合平滑升级脚本使用)。

用法:
    python scripts/migrate_sqlite_to_pg.py \
        --sqlite-url sqlite:////app/data/yolowebagent-starter.db \
        --pg-url postgresql+psycopg2://user:pass@host:port/dbname \
        [--truncate] [--skip-schema] [--batch-size 2000]

行为:
  1. 校验源库 alembic 版本 == 代码 head(防止旧 schema 搬到新结构上)。
  2. 在目标 PG 上执行 alembic upgrade head 建表(--skip-schema 跳过)。
  3. 目标业务表非空则拒绝执行,除非 --truncate(先清空全部业务表)。
  4. 单个源事务(快照)+ 单个目标事务(全有或全无)完成拷贝;
     自引用外键(model_versions.source_model_id)按拓扑序插入。
  5. 逐表核对行数,不一致以非零退出码结束。

源库只读,不做任何写操作;密码中的特殊字符在 URL 里需转义(@ → %40)。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import Table, create_engine, inspect, text  # noqa: E402

from app.core.database import Base  # noqa: E402
from app.core import models  # noqa: E402,F401

METADATA = Base.metadata
ALEMBIC_TABLE = "alembic_version"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SQLite → PostgreSQL 数据迁移")
    parser.add_argument("--sqlite-url", required=True, help="源 SQLite 连接串,如 sqlite:////app/data/yolowebagent-starter.db")
    parser.add_argument("--pg-url", required=True, help="目标 PostgreSQL 连接串,如 postgresql+psycopg2://user:pass@host/db")
    parser.add_argument("--truncate", action="store_true", help="目标业务表非空时先清空(危险:删除目标库现有数据)")
    parser.add_argument("--skip-schema", action="store_true", help="跳过 alembic upgrade head(目标库已有 schema 时)")
    parser.add_argument("--batch-size", type=int, default=2000, help="流式拷贝每批行数(默认 2000)")
    return parser.parse_args()


def alembic_config(database_url: str):
    from alembic.config import Config

    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    # alembic.ini 的 %(here)s 插值会把 % 吃掉,URL 里的 % 需要双写。
    config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    return config


def check_source_version(sqlite_engine) -> str:
    """源库 alembic 版本必须与代码 head 一致,否则结构对不上。"""
    from alembic.script import ScriptDirectory

    head = ScriptDirectory.from_config(alembic_config("sqlite://")).get_current_head()
    try:
        with sqlite_engine.connect() as connection:
            rows = connection.execute(text(f"SELECT version_num FROM {ALEMBIC_TABLE}")).fetchall()
    except Exception as exc:  # noqa: BLE001 - 表不存在等统一给出可读错误
        raise SystemExit(f"读取源库 {ALEMBIC_TABLE} 失败({exc}):源库可能从未被应用初始化过。") from exc
    source_version = rows[0][0] if rows else None
    if source_version != head:
        raise SystemExit(f"源库 alembic 版本({source_version})与代码 head({head})不一致:请先用当前版本应用在 SQLite 上完成升级后再迁移。")
    print(f"[1/5] 源库版本校验通过: {head}")
    return head


def ensure_schema(pg_url: str) -> None:
    from app.core.migrations import upgrade_database

    upgrade_database(BACKEND_ROOT, pg_url)


def check_target_empty(pg_engine, truncate: bool) -> None:
    non_empty = []
    with pg_engine.connect() as connection:
        for table in METADATA.sorted_tables:
            count = connection.execute(text(f'SELECT COUNT(*) FROM "{table.name}"')).scalar()
            if count:
                non_empty.append(f"{table.name}({count})")
        version = connection.execute(text(f"SELECT version_num FROM {ALEMBIC_TABLE}")).scalar()
    if version != head_expected():
        raise SystemExit(f"目标库 alembic 版本({version})与代码 head({head_expected()})不一致,请检查目标库。")
    if not non_empty:
        print("[3/5] 目标库为空,可直接迁移")
        return
    if not truncate:
        raise SystemExit(f"目标库已有数据:{'、'.join(non_empty)}。确认覆盖请加 --truncate。")
    names = ", ".join(f'"{table.name}"' for table in METADATA.sorted_tables)
    with pg_engine.begin() as connection:
        connection.execute(text(f"TRUNCATE {names} CASCADE"))
    print(f"[3/5] 已清空目标业务表:{len(non_empty)} 张")


def head_expected() -> str:
    from alembic.script import ScriptDirectory

    return ScriptDirectory.from_config(alembic_config("sqlite://")).get_current_head()


def self_reference_columns(table: Table) -> list[str]:
    """返回表上指向自身的外键列(拷贝时需按拓扑序插入)。"""
    return [
        foreign_key.parent.name
        for foreign_key in table.foreign_keys
        if foreign_key.column.table is table
    ]


def order_self_referential(rows: list[dict], table: Table) -> list[dict]:
    """自引用行按父先子后排序;出现环或悬空引用时报错。"""
    parent_columns = self_reference_columns(table)
    if not parent_columns:
        return rows
    pk_name = list(table.primary_key.columns)[0].name
    ordered: list[dict] = []
    placed: set[object] = set()
    pending = list(rows)
    while pending:
        remaining: list[dict] = []
        progressed = False
        for row in pending:
            parents = [row.get(column) for column in parent_columns if row.get(column) is not None]
            if all(parent in placed for parent in parents):
                ordered.append(row)
                placed.add(row[pk_name])
                progressed = True
            else:
                remaining.append(row)
        if not progressed:
            raise SystemExit(f"{table.name} 存在自引用外键环或悬空引用,无法确定插入顺序。")
        pending = remaining
    return ordered


def insert_rows(target, table: Table, rows: list[dict], batch_size: int) -> None:
    for start in range(0, len(rows), batch_size):
        target.execute(table.insert(), rows[start : start + batch_size])


def copy_data(sqlite_engine, pg_engine, batch_size: int) -> dict[str, int]:
    """单个源事务(快照)+ 单个目标事务(全有或全无)完成拷贝,返回逐表行数。"""
    counts: dict[str, int] = {}
    # 源连接不提交 → 全部读操作共享同一个 SQLite 快照。
    with sqlite_engine.connect() as source, pg_engine.begin() as target:
        for table in METADATA.sorted_tables:
            result = source.execute(table.select())
            if self_reference_columns(table):
                rows = [dict(row._mapping) for row in result]
                rows = order_self_referential(rows, table)
                insert_rows(target, table, rows, batch_size)
                counts[table.name] = len(rows)
                print(f"  · {table.name}: {len(rows)} 行(自引用已按拓扑序)")
                continue
            total = 0
            while True:
                chunk = [dict(row._mapping) for row in result.fetchmany(batch_size)]
                if not chunk:
                    break
                insert_rows(target, table, chunk, batch_size)
                total += len(chunk)
            counts[table.name] = total
            if total:
                print(f"  · {table.name}: {total} 行")
    return counts


def verify(sqlite_engine, pg_engine, copied: dict[str, int]) -> None:
    problems = []
    with sqlite_engine.connect() as source, pg_engine.connect() as target:
        for table in METADATA.sorted_tables:
            source_count = source.execute(text(f'SELECT COUNT(*) FROM "{table.name}"')).scalar()
            target_count = target.execute(text(f'SELECT COUNT(*) FROM "{table.name}"')).scalar()
            if source_count != target_count or source_count != copied.get(table.name):
                problems.append(f"{table.name}: 源 {source_count} / 目标 {target_count} / 已拷 {copied.get(table.name)}")
    if problems:
        raise SystemExit("行数核对不一致:" + ";".join(problems))
    print("[5/5] 行数核对一致,迁移完成 ✓")


def main() -> None:
    args = parse_args()
    if not args.pg_url.startswith(("postgresql://", "postgresql+")):
        raise SystemExit("--pg-url 必须是 postgresql:// 连接串。")
    try:
        import psycopg2  # noqa: F401
    except ImportError:
        raise SystemExit("缺少 psycopg2 依赖:请先 pip install psycopg2-binary。")

    sqlite_engine = create_engine(args.sqlite_url, future=True)
    pg_engine = create_engine(args.pg_url, future=True)

    inspector = inspect(sqlite_engine)
    source_tables = set(inspector.get_table_names())
    missing = {table.name for table in METADATA.sorted_tables} - source_tables
    if missing:
        raise SystemExit(f"源库缺少模型表:{'、'.join(sorted(missing))}")

    head = check_source_version(sqlite_engine)
    if args.skip_schema:
        print("[2/5] 跳过 schema 建立(--skip-schema)")
    else:
        ensure_schema(args.pg_url)
        print(f"[2/5] 目标库 schema 就绪: {head}")
    check_target_empty(pg_engine, args.truncate)
    print("[4/5] 开始拷贝数据 …")
    copied = copy_data(sqlite_engine, pg_engine, args.batch_size)
    print(f"     共拷贝 {sum(copied.values())} 行 / {len(copied)} 张表")
    verify(sqlite_engine, pg_engine, copied)


if __name__ == "__main__":
    main()
