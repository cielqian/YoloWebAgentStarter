from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

from app.core import pg_compat  # noqa: F401  # 导入即生效:瀚高 version() 兼容兜底


def _ensure_version_table(database_url: str) -> None:
    """预建 alembic_version(把 version_num 加宽到 VARCHAR(255))。

    Alembic 内部硬编码 version_num 为 VARCHAR(32):SQLite 不校验长度,
    PostgreSQL 严格校验,超过 32 字符的 revision id(如 0034_training_augmentation_params)
    会写入失败。预建后 Alembic 检测到表已存在即跳过自建,对 SQLite 无影响。
    """
    engine = create_engine(database_url)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "CREATE TABLE IF NOT EXISTS alembic_version ("
                    "version_num VARCHAR(255) NOT NULL, "
                    "CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))"
                )
            )
    finally:
        engine.dispose()


def upgrade_database(backend_root: Path, database_url: str) -> None:
    _ensure_version_table(database_url)
    config = Config(str(backend_root / "alembic.ini"))
    config.set_main_option("script_location", str(backend_root / "alembic"))
    config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    command.upgrade(config, "head")
