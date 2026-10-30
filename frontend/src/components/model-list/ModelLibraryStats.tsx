import { Statistic, Typography } from "antd";

interface Props {
  total: number;
  ptCount: number;
  onnxCount: number;
  bestMap50: string;
}

/** 模型库摘要条:antd Statistic 呈现四项关键指标。 */
export function ModelLibraryStats({ total, ptCount, onnxCount, bestMap50 }: Props) {
  return (
    <section className="models-stats-strip" aria-label="模型库摘要">
      <Statistic title={<Typography.Text type="secondary" style={{ fontSize: 11 }}>模型总数</Typography.Text>} value={total} />
      <Statistic title={<Typography.Text type="secondary" style={{ fontSize: 11 }}>PT 权重</Typography.Text>} value={ptCount} />
      <Statistic title={<Typography.Text type="secondary" style={{ fontSize: 11 }}>ONNX 产物</Typography.Text>} value={onnxCount} />
      <Statistic title={<Typography.Text type="secondary" style={{ fontSize: 11 }}>最佳 mAP50</Typography.Text>} value={bestMap50} />
    </section>
  );
}
