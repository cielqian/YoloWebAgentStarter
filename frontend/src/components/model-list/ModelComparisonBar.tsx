import { Button as AntdButton, Space, Typography } from "antd";
import type { ModelVersion } from "../../types";

interface Props {
  selectedIds: string[];
  models: ModelVersion[];
  compareBusy: boolean;
  busy: boolean;
  onCompareSelected: () => void;
  onCompareWithBest: () => void;
  onDeleteSelected: () => void;
  onDismiss: () => void;
}

export function ModelComparisonBar({
  selectedIds,
  models,
  compareBusy,
  busy,
  onCompareSelected,
  onCompareWithBest,
  onDeleteSelected,
  onDismiss,
}: Props) {
  if (!selectedIds.length) return null;

  return (
    <div className="comparison-bar">
      <div className="selection-info">
        <div className="selection-avatars">
          {selectedIds.slice(0, 3).map((id, index) => (
            <div key={id} className="avatar-mini" style={{ zIndex: 10 - index }}>
              {(models.find((item) => item.id === id)?.name ?? "?").slice(0, 2).toUpperCase()}
            </div>
          ))}
        </div>
        <div>
          <Typography.Text strong style={{ display: "block", fontSize: 14 }}>已选择 {selectedIds.length} 个模型</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>可对比指标，或批量删除</Typography.Text>
        </div>
      </div>
      <Space wrap>
        <AntdButton disabled={compareBusy || busy} onClick={onCompareWithBest}>与最佳对比</AntdButton>
        <AntdButton type="primary" disabled={compareBusy || busy || selectedIds.length !== 2} onClick={onCompareSelected}>
          {compareBusy ? "对比中…" : "对比所选"}
        </AntdButton>
        <AntdButton danger disabled={busy} onClick={onDeleteSelected}>删除所选</AntdButton>
        <AntdButton autoInsertSpace={false} onClick={onDismiss}>取消</AntdButton>
      </Space>
    </div>
  );
}
