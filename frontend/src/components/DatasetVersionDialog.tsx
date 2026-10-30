import { useEffect, useState } from "react";
import { Alert, Button as AntdButton, Empty as AntdEmpty, Flex, Input as AntdInput, Modal, Space, Space as AntdSpace, Spin, Tag as AntdTag, Typography } from "antd";
import { api } from "../api/client";
import type { Dataset, DatasetVersion } from "../types";

const formatTime = (value: string) => new Date(value).toLocaleString();
const versionName = (version: DatasetVersion) => version.version_label || `v${version.version_number}`;

export function DatasetVersionDialog({ dataset, onClose, onChanged }: { dataset: Dataset; onClose: () => void; onChanged: () => void }) {
  const [versions, setVersions] = useState<DatasetVersion[] | null>(null);
  const [note, setNote] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [switchTarget, setSwitchTarget] = useState<DatasetVersion>();
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);

  const activeVersion = versions?.find((item) => item.is_active);
  const nextNumber = (versions?.[0]?.version_number ?? 0) + 1;

  const reload = async () => {
    try {
      setVersions(await api.listDatasetVersions(dataset.id));
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "加载版本失败");
      setVersions([]);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.id]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      await api.createDatasetVersion(dataset.id, note, label);
      setNote("");
      setLabel("");
      await reload();
      onChanged();
    });

  const rename = (version: DatasetVersion) =>
    run(async () => {
      await api.renameDatasetVersion(dataset.id, version.id, renaming?.label ?? "");
      setRenaming(null);
      await reload();
      onChanged();
      setNotice(`版本号已更新为“${renaming?.label ?? ""}”`);
    });

  const skippedSuffix = (skipped: number) => (skipped ? `，${skipped} 张因文件缺失被跳过` : "");

  const activate = (version: DatasetVersion) =>
    run(async () => {
      const result = await api.activateDatasetVersion(dataset.id, version.id);
      await reload();
      onChanged();
      setNotice(`已激活 ${versionName(version)}：恢复 ${result.restored_images} 张图片` + skippedSuffix(result.skipped_images));
    });

  const archiveAndActivate = (version: DatasetVersion) =>
    run(async () => {
      try {
        const archived = await api.createDatasetVersion(dataset.id, "切换前自动归档");
        const result = await api.activateDatasetVersion(dataset.id, version.id);
        onChanged();
        setNotice(
          `已归档为 ${versionName(archived)} 并激活 ${versionName(version)}：恢复 ${result.restored_images} 张图片` +
            skippedSuffix(result.skipped_images),
        );
      } finally {
        await reload();
      }
    });

  const beginSwitch = (version: DatasetVersion) => {
    if (activeVersion?.has_pending_changes) {
      setSwitchTarget(version);
      return;
    }
    void activate(version);
  };

  const remove = (version: DatasetVersion) =>
    run(async () => {
      await api.deleteDatasetVersion(dataset.id, version.id);
      setConfirmDeleteId(undefined);
      await reload();
      onChanged();
    });

  return (
    <Modal className="dataset-version-modal" title={`版本管理 · ${dataset.name}`} open onCancel={onClose} footer={null} width={680}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 14, fontSize: 12 }}>
        新建版本会把当前图片、类别与标注归档为快照；激活中的版本显示当前工作区数据，激活历史版本可把工作区回滚到该快照。
      </Typography.Paragraph>
      <Flex gap={8} align="center" wrap="wrap">
        <AntdSpace.Compact block style={{ flex: "1 1 220px" }}>
          <AntdSpace.Addon>版本号</AntdSpace.Addon>
          <AntdInput
            value={label}
            placeholder={`默认 v${nextNumber}`}
            onChange={(event) => setLabel(event.target.value)}
            disabled={busy}
            aria-label="版本号"
          />
        </AntdSpace.Compact>
        <AntdSpace.Compact block style={{ flex: "1 1 260px" }}>
          <AntdSpace.Addon>版本备注</AntdSpace.Addon>
          <AntdInput value={note} placeholder="例如：修复了 20 张漏标" onChange={(event) => setNote(event.target.value)} disabled={busy} />
        </AntdSpace.Compact>
        <AntdButton type="primary" disabled={busy} onClick={() => void create()}>新建版本（快照当前数据）</AntdButton>
      </Flex>
      {error && <Alert type="error" showIcon title={error} style={{ marginTop: 12 }} />}
      {notice && <Alert type="success" showIcon title={notice} style={{ marginTop: 12 }} />}
      {switchTarget && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          title={`当前激活的 ${activeVersion ? versionName(activeVersion) : ""} 有未归档改动，切换到 ${versionName(switchTarget)} 将丢失这些改动。可先归档当前工作区（会生成一个新版本），再执行切换。`}
          action={
            <Space wrap>
              <AntdButton size="small" type="primary" disabled={busy} onClick={() => { setSwitchTarget(undefined); void archiveAndActivate(switchTarget); }}>
                归档并切换
              </AntdButton>
              <AntdButton size="small" danger disabled={busy} onClick={() => { setSwitchTarget(undefined); void activate(switchTarget); }}>
                放弃改动并切换
              </AntdButton>
              <AntdButton size="small" disabled={busy} onClick={() => setSwitchTarget(undefined)}>
                取消
              </AntdButton>
            </Space>
          }
        />
      )}
      <div className="dataset-version-list">
        {versions === null ? (
          <Space align="center" style={{ justifyContent: "center", width: "100%", padding: "18px 0" }}>
            <Spin size="small" />
            <Typography.Text type="secondary">加载中…</Typography.Text>
          </Space>
        ) : !versions.length ? (
          <AntdEmpty image={AntdEmpty.PRESENTED_IMAGE_SIMPLE} description="还没有版本。标注到合适的节点后，新建一个版本作为回滚点。" />
        ) : (
          versions.map((version) => (
            <div key={version.id} className={`dataset-version-row${version.is_active ? " active" : ""}`}>
              {renaming?.id === version.id ? (
                <div className="dataset-version-rename">
                  <AntdInput
                    size="small"
                    value={renaming.label}
                    autoFocus
                    aria-label="新版本号"
                    disabled={busy}
                    style={{ width: 140 }}
                    onChange={(event) => setRenaming({ id: version.id, label: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && renaming.label.trim()) void rename(version);
                      if (event.key === "Escape") setRenaming(null);
                    }}
                  />
                  <AntdButton size="small" type="primary" autoInsertSpace={false} disabled={busy || !renaming.label.trim()} onClick={() => void rename(version)}>保存</AntdButton>
                  <AntdButton size="small" autoInsertSpace={false} disabled={busy} onClick={() => setRenaming(null)}>取消</AntdButton>
                </div>
              ) : (
                <span
                  className="dataset-version-badge"
                  title="点击修改版本号"
                  role="button"
                  tabIndex={0}
                  onClick={() => setRenaming({ id: version.id, label: versionName(version) })}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setRenaming({ id: version.id, label: versionName(version) }); }}
                >
                  {versionName(version)}
                </span>
              )}
              <div className="dataset-version-meta">
                <strong>
                  {version.note || "（无备注）"}
                  {version.is_active && <AntdTag color="success" style={{ marginInlineStart: 8 }}>激活中</AntdTag>}
                  {version.is_active && version.has_pending_changes && <AntdTag color="warning">有未归档改动</AntdTag>}
                </strong>
                <Typography.Text type="secondary" className="dataset-version-meta-sub">
                  {version.image_count} 张图片 · {version.annotation_count} 条标注 · {version.class_count} 个类别 · {formatTime(version.created_at)}
                </Typography.Text>
              </div>
              <div className="dataset-version-actions">
                {!version.is_active && <AntdButton size="small" autoInsertSpace={false} disabled={busy} onClick={() => beginSwitch(version)}>激活</AntdButton>}
                {!version.is_active &&
                  (confirmDeleteId === version.id ? (
                    <AntdButton size="small" danger type="primary" disabled={busy} onClick={() => void remove(version)}>确认删除</AntdButton>
                  ) : (
                    <AntdButton size="small" danger autoInsertSpace={false} disabled={busy} onClick={() => setConfirmDeleteId(version.id)}>删除</AntdButton>
                  ))}
              </div>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}
