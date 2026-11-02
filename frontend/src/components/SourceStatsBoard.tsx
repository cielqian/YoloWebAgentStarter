import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Button as AntdButton, Card, Empty as AntdEmpty, Flex, Progress, Space, Statistic, Table, Tag as AntdTag, Typography, type TableProps } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import type { SourceStats } from "../types";

interface StatRow {
  key: string;
  name: ReactNode;
  count: number;
  meta?: ReactNode;
  children?: StatRow[];
}

/** 数据源统计看板:按 素材类型 → 标签 → 二级取值 → 数量 层级展示素材分布。 */
export function SourceStatsBoard() {
  const [stats, setStats] = useState<SourceStats>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setStats(await api.sourceStats());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载统计失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const totalImages = stats?.total_images ?? 0;

  const rows = useMemo<StatRow[]>(() => {
    if (!stats) return [];
    return stats.material_types.map((type) => ({
      key: `type:${type.name}`,
      name: (
        <Space size={6}>
          <strong>{type.name}</strong>
          {type.dataset_count > 0 ? <AntdTag color="blue">{type.dataset_count} 个数据源</AntdTag> : <AntdTag>未使用</AntdTag>}
        </Space>
      ),
      count: type.image_count,
      meta: type.description || undefined,
      children: type.tags.length ? type.tags.map((tag) => ({
        key: `type:${type.name}/tag:${tag.name}`,
        name: (
          <Space size={6}>
            <span className="source-tag-dot" style={{ background: tag.color }} />
            <span>{tag.name}</span>
          </Space>
        ),
        count: tag.image_count,
        children: tag.values.length
          ? tag.values.map((entry) => ({
              key: `type:${type.name}/tag:${tag.name}/${entry.value}`,
              name: <Typography.Text type="secondary">{entry.value}</Typography.Text>,
              count: entry.image_count,
            }))
          : undefined,
      })) : undefined,
    }));
  }, [stats]);

  const columns: TableProps<StatRow>["columns"] = [
    {
      title: "素材类型 / 标签 / 二级取值",
      key: "name",
      render: (_, row) => row.name,
    },
    {
      title: "数量",
      key: "count",
      width: 240,
      align: "right",
      render: (_, row) => (
        <Space size={8}>
          <Typography.Text style={{ fontVariantNumeric: "tabular-nums", fontWeight: 650, minWidth: 44, textAlign: "right" }}>{row.count}</Typography.Text>
          <Progress
            percent={totalImages ? Math.round((row.count / totalImages) * 100) : 0}
            size="small"
            showInfo={false}
            style={{ width: 120, margin: 0 }}
          />
        </Space>
      ),
    },
    { title: "说明", key: "meta", width: 220, ellipsis: true, render: (_, row) => row.meta || <Typography.Text type="secondary">—</Typography.Text> },
  ];

  return (
    <div className="source-stats-board">
      {error && <Alert type="error" showIcon closable title={error} style={{ marginBottom: 12 }} onClose={() => setError("")} />}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Flex justify="space-between" align="center" style={{ marginBottom: 8 }}>
          <Typography.Text strong>素材总览</Typography.Text>
          <AntdButton size="small" icon={<ReloadOutlined />} disabled={loading} onClick={() => void load()}>刷新</AntdButton>
        </Flex>
        <div className="source-stats-summary">
          <Statistic title="素材总数" value={totalImages} loading={loading} />
          <Statistic title="数据源" value={stats?.total_datasets ?? 0} loading={loading} />
          <Statistic title="素材类型（使用中）" value={`${stats?.material_types.filter((item) => item.dataset_count > 0 && item.name !== "未设置类型").length ?? 0}/${stats?.material_types.filter((item) => item.name !== "未设置类型").length ?? 0}`} loading={loading} />
          <Statistic title="标签" value={stats?.tags.length ?? 0} loading={loading} />
        </div>
      </Card>

      <Card size="small" title="素材分布（素材类型 → 标签 → 二级取值）">
        {rows.length ? (
          <Table<StatRow>
            rowKey="key"
            size="small"
            columns={columns}
            dataSource={rows}
            pagination={false}
            loading={loading}
            defaultExpandAllRows
            expandable={{ defaultExpandAllRows: true }}
          />
        ) : (
          <AntdEmpty image={AntdEmpty.PRESENTED_IMAGE_SIMPLE} description="素材类型库还是空的；到「设置 → 基础数据 → 素材类型」添加后，数据源即可多选打标。" style={{ padding: "18px 0" }} />
        )}
      </Card>
    </div>
  );
}
