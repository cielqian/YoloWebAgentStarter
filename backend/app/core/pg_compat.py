"""瀚高等国产 PG 兼容库的方言兼容补丁。

瀚高安全版的 version() 返回营销字符串(如"瀚高安全版数据库系统V4.5.7…"),
SQLAlchemy 的 PG 方言解析不出来会直接拒绝连接。这里在方言上包一层兜底:
解析失败时改读标准协议字段 server_version_num(如 120007 → (12, 0, 7))。
标准 PostgreSQL 解析成功即走原路径,不受影响。
"""

from __future__ import annotations

from sqlalchemy.dialects.postgresql.base import PGDialect

_original_get_server_version_info = PGDialect._get_server_version_info


def _get_server_version_info_with_fallback(self, connection):  # noqa: ANN001
    try:
        return _original_get_server_version_info(self, connection)
    except AssertionError:
        number = int(connection.exec_driver_sql("SHOW server_version_num").scalar())
        return (number // 10000, number // 100 % 100, number % 100)


PGDialect._get_server_version_info = _get_server_version_info_with_fallback
