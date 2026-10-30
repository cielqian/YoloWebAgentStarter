import { useEffect, useMemo, useState } from "react";
import { Button as AntdButton, Form, Input as AntdInput, Space, Table, Tag as AntdTag, Tabs, Typography, type TableProps } from "antd";
import { api } from "../../api/client";
import type {
  Dataset,
  ModelEvaluationRecord,
  ModelVersion,
  SplitName,
} from "../../types";
import { ModelEvaluationPanel } from "../ModelEvaluationPanel";
import {
  fileName,
  formatMetric,
  metricBarWidth,
  modelTaskLabel,
  newerFirst,
} from "../../models/helpers";

interface Props {
  /** 跨数据集模型库按 dataset_id 反查；数据集已被删除时可能为空。 */
  dataset?: Dataset;
  model: ModelVersion;
  models: ModelVersion[];
  evaluations: ModelEvaluationRecord[];
  busy: boolean;
  onBack: () => void;
  onSelectModel: (model: ModelVersion) => void;
  onTest: (model: ModelVersion) => void;
  onExportOnnx: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
  onEvaluate: (split: SplitName) => void;
  onSaved: (model: ModelVersion) => void;
}

export function ModelDetailView({
  dataset,
  model,
  models,
  evaluations,
  busy,
  onBack,
  onSelectModel,
  onTest,
  onExportOnnx,
  onToggleArchive,
  onDelete,
  onEvaluate,
  onSaved,
}: Props) {
  const [tab, setTab] = useState<string>("overview");
  const [name, setName] = useState(model.name);
  const [version, setVersion] = useState(model.version);
  const [notes, setNotes] = useState(model.notes);
  const siblings = useMemo(
    () => [...models].filter((item) => item.task_type === model.task_type).sort(newerFirst),
    [models, model.task_type],
  );

  useEffect(() => {
    setName(model.name);
    setVersion(model.version);
    setNotes(model.notes);
  }, [model.id, model.name, model.version, model.notes]);

  const save = async () => {
    const updated = await api.updateModel(model.id, { name: name.trim(), version: version.trim(), notes });
    onSaved(updated);
  };

  const lineage = [
    { id: "dataset", label: dataset?.name ?? "未关联数据集" },
    model.base_model ? { id: "base", label: model.base_model } : null,
    model.training_task_id ? { id: "train", label: "训练任务" } : null,
    { id: "artifact", label: model.artifact_type === model.format ? model.format : `${model.artifact_type}.${model.format}`, highlight: true },
    { id: "file", label: fileName(model.model_path), highlight: true },
  ].filter(Boolean) as Array<{ id: string; label: string; highlight?: boolean }>;

  const versionColumns: TableProps<ModelVersion>["columns"] = [
    {
      title: "名称",
      key: "name",
      render: (_, item) => (
        <AntdButton type="link" size="small" style={{ padding: 0, height: "auto" }} onClick={() => onSelectModel(item)}>{item.name}</AntdButton>
      ),
    },
    { title: "格式", key: "format", render: (_, item) => `${item.format.toUpperCase()} · ${item.artifact_type}` },
    { title: "mAP50", key: "map50", align: "right", render: (_, item) => formatMetric(item.map50) },
    { title: "状态", key: "status", width: 90, render: (_, item) => (item.status === "active" ? "启用" : "归档") },
    { title: "创建", key: "created", render: (_, item) => item.created_at.slice(0, 16).replace("T", " ") },
  ];

  return (
    <div className="mdd-shell">
      <div className="mdd-topbar">
        <AntdButton onClick={onBack}>← 返回模型库</AntdButton>
        <div className="mdd-topbar-meta">
          <Space size={8}>
            <AntdTag>{dataset?.name ?? "未关联数据集"}</AntdTag>
            <AntdTag color="blue">{modelTaskLabel(model)}</AntdTag>
          </Space>
        </div>
      </div>

      <header className="mdd-header">
        <div className="mdd-header-main">
          <Typography.Text type="secondary" className="models-eyebrow">MODEL DETAIL / {model.task_type.toUpperCase()}</Typography.Text>
          <Typography.Title level={3} style={{ margin: 0 }}>{model.name}</Typography.Title>
          <Typography.Text type="secondary">{model.format.toUpperCase()} · {model.artifact_type} · {model.source === "training_task" ? "受管训练产物" : "导出产物"}</Typography.Text>
          <div className="mdd-header-tags">
            <AntdTag color={model.status === "active" ? "success" : "default"}>{model.status === "active" ? "启用" : "已归档"}</AntdTag>
            <AntdTag>v{model.version}</AntdTag>
            {model.base_model && <AntdTag>{model.base_model}</AntdTag>}
          </div>
        </div>
        <div className="mdd-header-actions">
          <AntdButton href={api.downloadModelUrl(model.id)}>下载 {model.format.toUpperCase()}</AntdButton>
          {model.format === "pt" && (
            <>
              <AntdButton type="primary" disabled={busy} onClick={() => onTest(model)}>快速测试</AntdButton>
              <AntdButton disabled={busy} onClick={onExportOnnx}>导出 ONNX</AntdButton>
            </>
          )}
          <AntdButton disabled={busy} onClick={onToggleArchive}>
            {model.status === "active" ? "归档" : "恢复"}
          </AntdButton>
          <AntdButton danger autoInsertSpace={false} disabled={busy} onClick={onDelete}>删除</AntdButton>
        </div>
      </header>

      <div className="mdd-summary-grid">
        <div className="mdd-summary-card">
          <small>状态</small>
          <strong>{model.status === "active" ? "可用" : "已归档"}</strong>
          <span>{model.format.toUpperCase()} · {model.artifact_type}</span>
        </div>
        <div className="mdd-summary-card">
          <small>mAP50</small>
          <strong>{formatMetric(model.map50)}</strong>
          <span>mAP50-95 {formatMetric(model.map50_95)}</span>
        </div>
        <div className="mdd-summary-card">
          <small>导出格式</small>
          <strong>{model.format === "onnx" ? "ONNX FP32" : "PyTorch PT"}</strong>
          <span>{model.engine_type}</span>
        </div>
        <div className="mdd-summary-card">
          <small>来源</small>
          <strong>{model.source === "training_task" ? "受管训练" : "导出产物"}</strong>
          <span>{model.created_at.slice(0, 16).replace("T", " ")}</span>
        </div>
      </div>

      <div className="mdd-layout">
        <div className="mdd-main">
          <Tabs
            activeKey={tab}
            onChange={setTab}
            items={[
              { key: "overview", label: "概览", children: (
                <div className="mdd-overview" style={{ display: "grid", gap: 16 }}>
                  <section className="mdd-panel">
                    <header className="mdd-panel-head"><Typography.Title level={5} style={{ margin: 0 }}>模型血缘</Typography.Title></header>
                    <div className="mdd-panel-body">
                      <div className="mdd-lineage">
                        {lineage.map((node, index) => (
                          <div key={node.id} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            {index > 0 && <span className="mdd-lineage-arrow">›</span>}
                            <span className={`mdd-lineage-node${node.highlight ? " highlight" : ""}`}>{node.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </section>

                  <div className="mdd-metrics-row">
                    <article className="mdd-panel">
                      <div className="mdd-panel-body">
                        <p className="mdd-metric-section-label">Precision / Recall</p>
                        <div className="mdd-pr-grid">
                          <div>
                            <strong>{formatMetric(model.precision)}</strong>
                            <div className="mdd-metric-bar">
                              <span className="blue" style={{ width: metricBarWidth(model.precision) }} />
                            </div>
                            <span>Precision</span>
                          </div>
                          <div>
                            <strong>{formatMetric(model.recall)}</strong>
                            <div className="mdd-metric-bar">
                              <span className="green" style={{ width: metricBarWidth(model.recall) }} />
                            </div>
                            <span>Recall</span>
                          </div>
                        </div>
                      </div>
                    </article>
                    <article className="mdd-panel">
                      <div className="mdd-panel-body">
                        <p className="mdd-metric-section-label">Detection quality</p>
                        <div className="mdd-map-block">
                          <strong className="mdd-map-value">{formatMetric(model.map50)}</strong>
                          <p className="mdd-muted">mAP50-95 · {formatMetric(model.map50_95)}</p>
                        </div>
                      </div>
                    </article>
                  </div>

                  <section className="mdd-panel">
                    <header className="mdd-panel-head"><Typography.Title level={5} style={{ margin: 0 }}>下一步</Typography.Title></header>
                    <div className="mdd-panel-body">
                      <div className="mdd-next-actions">
                        {model.format === "pt" && (
                          <>
                            <AntdButton type="primary" disabled={busy} onClick={() => onTest(model)}>运行快速测试</AntdButton>
                            <AntdButton disabled={busy} onClick={() => setTab("evaluation")}>创建 split 评估</AntdButton>
                            <AntdButton disabled={busy} onClick={onExportOnnx}>导出 ONNX FP32</AntdButton>
                          </>
                        )}
                        {model.format === "onnx" && (
                          <AntdButton type="primary" href={api.downloadModelUrl(model.id)}>下载 ONNX</AntdButton>
                        )}
                      </div>
                    </div>
                  </section>
                </div>
              ) },
              { key: "evaluation", label: "评估", children: (
                model.format === "pt"
                  ? <ModelEvaluationPanel model={model} evaluations={evaluations} busy={busy} onEvaluate={onEvaluate} />
                  : <section className="mdd-panel"><div className="mdd-panel-body"><p className="mdd-muted">ONNX 产物请回到源 PT 模型创建评估任务。</p></div></section>
              ) },
              { key: "versions", label: "版本历史", children: (
                <section className="mdd-panel">
                  <header className="mdd-panel-head"><Typography.Title level={5} style={{ margin: 0 }}>同数据集版本</Typography.Title></header>
                  <div className="mdd-panel-body" style={{ padding: 0 }}>
                    <Table<ModelVersion>
                      rowKey="id"
                      size="small"
                      columns={versionColumns}
                      dataSource={siblings}
                      pagination={false}
                      rowClassName={(item) => (item.id === model.id ? "active" : "")}
                    />
                  </div>
                </section>
              ) },
              { key: "metadata", label: "元数据", children: (
                <section className="mdd-panel">
                  <header className="mdd-panel-head"><Typography.Title level={5} style={{ margin: 0 }}>编辑元数据</Typography.Title></header>
                  <div className="mdd-panel-body">
                    <Form layout="vertical" className="mdd-form">
                      <Form.Item label="名称" style={{ marginBottom: 12 }}>
                        <AntdInput value={name} onChange={(event) => setName(event.target.value)} />
                      </Form.Item>
                      <Form.Item label="版本" style={{ marginBottom: 12 }}>
                        <AntdInput value={version} onChange={(event) => setVersion(event.target.value)} />
                      </Form.Item>
                      <Form.Item label="备注" style={{ marginBottom: 12 }}>
                        <AntdInput.TextArea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} />
                      </Form.Item>
                      <AntdButton type="primary" disabled={busy || !name.trim() || !version.trim()} onClick={() => void save()}>
                        保存元数据
                      </AntdButton>
                    </Form>
                  </div>
                </section>
              ) },
            ]}
          />
        </div>

        <aside className="mdd-sidebar">
          <div className="mdd-sidebar-card">
            <Typography.Title level={5} style={{ margin: 0 }}>就绪检查</Typography.Title>
            <ul className="mdd-ready-list">
              <li><span>权重文件</span><span className="ok">已登记</span></li>
              <li><span>训练来源</span><span className={model.training_task_id ? "ok" : "pending"}>{model.training_task_id ? "已关联" : "无"}</span></li>
              <li><span>评估指标</span><span className={typeof model.map50 === "number" ? "ok" : "pending"}>{typeof model.map50 === "number" ? "有" : "待评估"}</span></li>
              <li><span>ONNX</span><span className={model.format === "onnx" || models.some((item) => item.source_model_id === model.id && item.format === "onnx") ? "ok" : "pending"}>{model.format === "onnx" ? "当前即为 ONNX" : models.some((item) => item.source_model_id === model.id && item.format === "onnx") ? "已导出" : "未导出"}</span></li>
            </ul>
          </div>
          <div className="mdd-sidebar-card">
            <Typography.Title level={5} style={{ margin: 0 }}>文件路径</Typography.Title>
            <p className="mdd-path">{model.model_path}</p>
          </div>
          <div className="mdd-sidebar-card">
            <Typography.Title level={5} style={{ margin: 0 }}>备注预览</Typography.Title>
            <p className="mdd-muted">{model.notes.trim() || "暂无备注"}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
