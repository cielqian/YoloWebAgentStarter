import { useCallback, useEffect, useState } from "react";
import { Alert, Button as AntdButton, Card, Empty as AntdEmpty, Flex, Progress, Space, Statistic, Table, Tag as AntdTag, Typography, type TableProps } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import type { SourceStats, SourceStatsMaterialType, SourceStatsTag } from "../types";

/** 数据源统计看板:跨数据源展示每个素材类型与所有标签的素材数量。 */
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
  const usedTypes = stats?.material_types.filter((item) => item.dataset_count > 0).length ?? 0;

  const typeColumns: TableProps<SourceStatsMaterialType>["columns"] = [
    { title: "素材类型", key: "name", render: (_, item) => (
      <Space size={6}>
        <strong>{item.name}</strong>
        {item.dataset_count > 0 ? <AntdTag color="blue">{item.dataset_count} 个数据源</AntdTag> : <AntdTag>未使用</AntdTag>}
      </Space>
    ) },
    { title: "说明", dataIndex: "description", key: "description", ellipsis: true, render: (value: string | null) => value || <Typography.Text type="secondary">—</Typography.Text> },
    { title: "素材数量", dataIndex: "image_count", key: "image_count", width: 220, render: (value: number) => (
      <Space size={8}>
        <Typography.Text style={{ fontVariantNumeric: "tabular-nums", fontWeight: 650, minWidth: 42, textAlign: "right" }}>{value}</Typography.Text>
        <Progress percent={totalImages ? Math.round((value / totalImages) * 100) : 0} size="small" showInfo={false} style={{ width: 110, margin: 0 }} />
      </Space>
    ) },
  ];

  const tagColumns: TableProps<SourceStatsTag>["columns"] = [
    { title: "标签", key: "name", render: (_, item) => (
      <Space size={6}>
        <span className="source-tag-dot" style={{ background: item.color }} />
        <strong>{item.name}</strong>
      </Space>
    ) },
    { title: "素材数量", dataIndex: "image_count", key: "image_count", width: 220, render: (value: number) => (
      <Space size={8}>
        <Typography.Text style={{ fontVariantNumeric: "tabular-nums", fontWeight: 650, minWidth: 42, textAlign: "right" }}>{value}</Typography.Text>
        <Progress percent={totalImages ? Math.round((value / totalImages) * 100) : 0} size="small" showInfo={false} style={{ width: 110, margin: 0 }} />
      </Space>
    ) },
    { title: "取值分布", key: "values", render: (_, item) => (
      item.values.length
        ? <Space size={4} wrap>{item.values.map((entry) => <AntdTag key={entry.value}>{entry.value} · {entry.image_count}</AntdTag>)}</Space>
        : <Typography.Text type="secondary">—</Typography.Text>
    ) },
  ];

  return (
    <div className="source-stats-board">
      {error && <Alert type="error" showIcon closable title={error} style={{ marginBottom: 12 }} />}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Flex justify="space-between" align="center" style={{ marginBottom: 8 }}>
          <Typography.Text strong>素材总览</Typography.Text>
          <AntdButton size="small" icon={<ReloadOutlined />} disabled={loading} onClick={() => void load()}>刷新</AntdButton>
        </Flex>
        <div className="source-stats-summary">
          <Statistic title="素材总数" value={totalImages} loading={loading} />
          <Statistic title="数据源" value={stats?.total_datasets ?? 0} loading={loading} />
          <Statistic title="素材类型（使用中）" value={`${usedTypes}/${stats?.material_types.length ?? 0}`} loading={loading} />
          <Statistic title="标签" value={stats?.tags.length ?? 0} loading={loading} />
        </div>
      </Card>

      <Card size="small" title="素材类型分布" style={{ marginBottom: 16 }}>
        {stats?.material_types.length ? (
          <Table<SourceStatsMaterialType> rowKey="name" size="small" columns={typeColumns} dataSource={stats.material_types} pagination={false} loading={loading} />
        ) : (
          <AntdEmpty image={AntdEmpty.PRESENTED_IMAGE_SIMPLE} description="素材类型库还是空的；到「设置 → 基础数据 → 素材类型」添加后，数据源即可多选打标。" style={{ padding: "18px 0" }} />
        )}
      </Card>

      <Card size="small" title="标签分布">
        {stats?.tags.length ? (
          <Table<SourceStatsTag> rowKey={(item) => item.name} size="small" columns={tagColumns} dataSource={stats.tags} pagination={false} loading={loading} />
        ) : (
          <AntdEmpty image={AntdEmpty.PRESENTED_IMAGE_SIMPLE} description="还没有标签；进入数据源详情页创建标签并应用到图片后，这里会汇总展示。" style={{ padding: "18px 0" }} />
        )}
      </Card>
    </div>
  );
}
