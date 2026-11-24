import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button as AntdButton,
  Flex,
  Form,
  Input as AntdInput,
  Modal,
  Popconfirm,
  Progress,
  Radio,
  Select as AntdSelect,
  Space,
  Table,
  Tag as AntdTag,
  Tooltip,
  Typography,
  Upload,
  type TableProps,
} from "antd";
import { InboxOutlined, MoreOutlined } from "@ant-design/icons";
import { api, type UploadProgress } from "../api/client";
import { AnnotationView } from "../App";
import type { AnnotationDraft } from "../annotation/AnnotationCanvas";
import { confirmDialog } from "../components/confirm";
import { Toast } from "../components/Toast";
import { UploadProgressToast } from "../components/UploadProgressToast";
import type {
  Annotation,
  ClassLabel,
  FtpEntry,
  ImageItem,
  TestAnnotation,
  TestClassLabel,
  TestDataset,
  TestImage,
  TestImageNeighbors,
  TestPurposeTag,
  TestTaskType,
} from "../types";
import { TEST_PURPOSE_LABELS } from "../types";

/** 预期标注复用 AnnotationView:把测试侧数据适配成它的入参形状。 */
function testImageToImageItem(image: TestImage): ImageItem {
  return {
    id: image.id,
    dataset_id: image.test_dataset_id,
    file_name: image.file_name,
    width: image.width,
    height: image.height,
    split: "test",
    status: image.status === "marked" ? "annotated" : "unannotated",
    file_url: api.testImageUrl(image.id),
    created_at: image.created_at,
    updated_at: image.created_at,
  };
}

function testClassToClassLabel(item: TestClassLabel): ClassLabel {
  return { ...item, dataset_id: item.test_dataset_id, sam3_prompt: null };
}

function testAnnotationToAnnotation(item: TestAnnotation): Annotation {
  return { ...item, dataset_id: item.test_dataset_id, keypoints: null, source: "manual" } as Annotation;
}

const TASK_TYPE_OPTIONS: Array<{ value: TestTaskType; label: string }> = [
  { value: "detect", label: "目标检测" },
  { value: "classify", label: "图像分类" },
  { value: "segment", label: "语义分割" },
  { value: "obb", label: "旋转框检测" },
];

const PURPOSE_OPTIONS: Array<{ value: TestPurposeTag; label: string }> = [
  { value: "regression", label: "回归基线" },
  { value: "augment", label: "扩充集" },
  { value: "hard", label: "难例集" },
  { value: "acceptance", label: "验收集" },
];

function taskLabel(taskType: TestTaskType): string {
  return TASK_TYPE_OPTIONS.find((item) => item.value === taskType)?.label ?? taskType;
}

/** 列表页 / 预期标注页 两种内部形态。 */
type PageMode = { kind: "list" } | { kind: "annotation"; dataset: TestDataset; image: ImageItem };

/**
 * 算法测试模块(P1):测试数据集管理 + 预期结果标注。
 * 与训练数据集完全独立;后续阶段在此模块内追加 算法服务管理 / 测试任务 / 记录。
 */
export function AlgorithmTestView({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const [datasets, setDatasets] = useState<TestDataset[]>([]);
  const [mode, setMode] = useState<PageMode>({ kind: "list" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [ftpOpen, setFtpOpen] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<TestDataset>();
  const [uploadProgress, setUploadProgress] = useState<{ progress: UploadProgress } | null>(null);
  // 标注态数据
  const [classes, setClasses] = useState<ClassLabel[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [activeClassId, setActiveClassId] = useState("");
  const [imageListVersion, setImageListVersion] = useState(0);
  const [neighbors, setNeighbors] = useState<TestImageNeighbors>();
  const [annotationDirty, setAnnotationDirty] = useState(false);
  const annotationDirtyRef = useRef(false);
  useEffect(() => { annotationDirtyRef.current = annotationDirty; onDirtyChange?.(annotationDirty); }, [annotationDirty, onDirtyChange]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败，请稍后重试。"); } finally { setBusy(false); }
  }, []);

  const refreshDatasets = useCallback(async () => {
    const items = await api.listTestDatasets();
    setDatasets(items);
    if (mode.kind === "annotation") {
      const current = items.find((item) => item.id === mode.dataset.id);
      if (current) setMode({ kind: "annotation", dataset: current, image: mode.image });
    }
  }, [mode]);

  useEffect(() => {
    void run(async () => { await refreshDatasets(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 有测试数据集在 FTP 建集时轮询列表;完成/失败时提示结果。
  const importStatesRef = useRef<Record<string, string | null | undefined>>({});
  useEffect(() => {
    const states: Record<string, string | null | undefined> = {};
    for (const dataset of datasets) states[dataset.id] = dataset.import_state ?? null;
    const previous = importStatesRef.current;
    for (const dataset of datasets) {
      const before = previous[dataset.id];
      const now = states[dataset.id];
      if (before === "importing" && now === "completed") {
        setNotice(`「${dataset.name}」FTP 建集完成：${dataset.image_count} 张图片。`);
      } else if (before === "importing" && now === "failed") {
        setError(`「${dataset.name}」FTP 建集失败：${dataset.import_message ?? "未知错误"}`);
      }
    }
    importStatesRef.current = states;
  }, [datasets]);

  const hasImportingDataset = mode.kind === "list" && datasets.some((dataset) => dataset.import_state === "importing");
  useEffect(() => {
    if (!hasImportingDataset) return;
    const timer = window.setInterval(() => {
      api.listTestDatasets().then(setDatasets).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasImportingDataset]);

  // 标注态:当前图片变化时刷新邻居。
  useEffect(() => {
    if (mode.kind !== "annotation") return;
    api.testImageNeighbors(mode.dataset.id, mode.image.id).then(setNeighbors).catch(() => setNeighbors(undefined));
  }, [mode, imageListVersion]);

  /** 打开一张测试图片进入预期标注。 */
  const showImage = async (dataset: TestDataset, image: TestImage) => {
    setMode({ kind: "annotation", dataset, image: testImageToImageItem(image) });
    setAnnotations((await api.getTestAnnotations(dataset.id, image.id)).map(testAnnotationToAnnotation));
  };

  const openImage = async (image: ImageItem, options?: { ignoreDirty?: boolean }) => {
    if (mode.kind !== "annotation") return;
    if (!options?.ignoreDirty && annotationDirtyRef.current) {
      const confirmed = await confirmDialog({ title: "当前图片的标注尚未保存", description: "切换图片会丢弃未保存的修改。", confirmLabel: "丢弃并切换", danger: true });
      if (!confirmed) return;
    }
    setAnnotationDirty(false);
    // 入参可能来自侧栏/邻居(原始 TestImage,status 为 marked/unmarked),也可能来自 AnnotationView 内部
    // (映射过的 ImageItem,status 为 annotated/unannotated),双域都归一到 marked。
    const marked = image.status === "annotated" || image.status === "marked";
    await showImage(mode.dataset, { ...image, test_dataset_id: mode.dataset.id, status: marked ? "marked" : "unmarked", point_id: null, ftp_path: null } as unknown as TestImage);
  };

  const saveAnnotations = async (drafts: AnnotationDraft[]) => {
    if (mode.kind !== "annotation") return false;
    let ok = false;
    await run(async () => {
      const saved = await api.replaceTestAnnotations(mode.dataset.id, mode.image.id, drafts.map(({ id: _id, ...item }) => item));
      setAnnotations(saved.map(testAnnotationToAnnotation));
      setAnnotationDirty(false);
      setImageListVersion((value) => value + 1);
      setNotice("预期标注已保存");
      ok = true;
    });
    return ok;
  };

  const continueAnnotation = async (dataset: TestDataset) => {
    await run(async () => {
      const nextClasses = (await api.listTestClasses(dataset.id)).map(testClassToClassLabel);
      setClasses(nextClasses);
      setActiveClassId(nextClasses[0]?.id ?? "");
      // 优先打开第一张未标记的图片;全部标记过则打开第一张。
      const unmarked = await api.listTestImagesPage(dataset.id, 0, 1, { status: "unmarked" });
      const first = unmarked.items[0] ? unmarked : await api.listTestImagesPage(dataset.id, 0, 1);
      const image = first.items[0];
      if (!image) {
        setNotice("该测试数据集还没有图片，请先上传。");
        return;
      }
      await showImage(dataset, image);
    });
  };

  const backToList = async () => {
    if (annotationDirtyRef.current) {
      const confirmed = await confirmDialog({ title: "当前图片的标注尚未保存", description: "返回列表会丢弃未保存的修改。", confirmLabel: "丢弃并返回", danger: true });
      if (!confirmed) return;
    }
    setAnnotationDirty(false);
    setMode({ kind: "list" });
    await refreshDatasets();
  };

  const deleteDataset = async (dataset: TestDataset) => {
    await run(async () => {
      await api.deleteTestDataset(dataset.id);
      setDatasets((items) => items.filter((item) => item.id !== dataset.id));
      setNotice(`测试数据集「${dataset.name}」已删除`);
    });
  };

  const submitCreate = async () => {
    const values = await createForm.validateFields();
    await run(async () => {
      const created = await api.createTestDataset(values);
      setCreateOpen(false);
      createForm.resetFields();
      setDatasets((items) => [created, ...items]);
      setNotice(`测试数据集「${created.name}」已创建，可上传图片并标记预期结果`);
    });
  };

  const stopImport = async (dataset: TestDataset) => {
    await run(async () => {
      await api.cancelTestDatasetImport(dataset.id);
      await refreshDatasets();
      setNotice(`「${dataset.name}」已停止导入。`);
    });
  };

  const uploadFiles = async (dataset: TestDataset, files: File[]) => {
    if (!files.length) return;
    await run(async () => {
      setUploadProgress({ progress: { loaded: 0, total: files.length, percent: 0 } as unknown as UploadProgress });
      const result = await api.uploadTestImages(dataset.id, files, (progress) => setUploadProgress({ progress }));
      setUploadTarget(undefined);
      setUploadProgress(null);
      await refreshDatasets();
      setNotice(
        result.duplicates.length
          ? `已上传 ${result.imported} 张图片，${result.duplicates.length} 张重复被跳过`
          : `已上传 ${result.imported} 张图片`,
      );
    });
    setUploadProgress(null);
  };

  const createTestClass = async (name: string, color: string): Promise<ClassLabel | undefined> => {
    if (mode.kind !== "annotation") return undefined;
    try {
      const created = testClassToClassLabel(await api.createTestClass(mode.dataset.id, name, color));
      setClasses((items) => [...items, created].sort((left, right) => left.class_index - right.class_index));
      setActiveClassId(created.id);
      setNotice(`已新增测试类别「${created.name}」`);
      return created;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新增类别失败");
      return undefined;
    }
  };

  const importTestClasses = async (templateIds: string[]): Promise<ClassLabel[] | undefined> => {
    if (mode.kind !== "annotation") return undefined;
    try {
      const result = await api.importTestClasses(mode.dataset.id, templateIds);
      const next = (await api.listTestClasses(mode.dataset.id)).map(testClassToClassLabel);
      setClasses(next);
      if (!activeClassId && next[0]) setActiveClassId(next[0].id);
      setNotice(result.skipped_names.length ? `已导入 ${result.imported.length} 个类别，同名跳过：${result.skipped_names.join("、")}` : `已导入 ${result.imported.length} 个类别`);
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导入类别失败");
      return undefined;
    }
  };

  const deleteTestClassById = async (classId: string): Promise<boolean | undefined> => {
    if (mode.kind !== "annotation") return undefined;
    try {
      await api.deleteTestClass(mode.dataset.id, classId);
      const next = (await api.listTestClasses(mode.dataset.id)).map(testClassToClassLabel);
      setClasses(next);
      if (activeClassId === classId) setActiveClassId(next[0]?.id ?? "");
      setNotice("测试类别已删除");
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除类别失败");
      return undefined;
    }
  };

  const deleteTestImages = async (imageIds: string[]): Promise<boolean> => {
    if (mode.kind !== "annotation") return false;
    try {
      setBusy(true);
      for (const id of imageIds) await api.deleteTestImage(mode.dataset.id, id);
      setNotice(`已删除 ${imageIds.length} 张图片`);
      if (imageIds.includes(mode.image.id)) {
        setAnnotationDirty(false);
        const next = neighbors?.next ?? neighbors?.previous;
        if (next) await showImage(mode.dataset, next);
        else setMode({ kind: "list" });
      } else if (neighbors?.next && imageIds.includes(neighbors.next.id)) {
        setNeighbors(undefined);
      }
      setImageListVersion((value) => value + 1);
      await refreshDatasets();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除图片失败");
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (mode.kind === "annotation") {
    return (
      <>
        <Toast kind="error" message={error} onClose={() => setError("")} />
        <Toast kind="success" message={notice} onClose={() => setNotice("")} />
        <AnnotationView
          mode="test"
          dataset={mode.dataset}
          image={mode.image}
          imageListVersion={imageListVersion}
          onImageSelect={(image) => void openImage(image)}
          classes={classes}
          annotations={annotations}
          activeClassId={activeClassId}
          onClassChange={setActiveClassId}
          onBack={() => void backToList()}
          onPrevious={() => { if (neighbors?.previous) void openImage(neighbors.previous as unknown as ImageItem); }}
          onNext={async (drafts) => {
            const target = neighbors?.next;
            if (!target) return;
            if (annotationDirtyRef.current && drafts) {
              if (!(await saveAnnotations(drafts))) return;
            }
            void openImage(target as unknown as ImageItem, { ignoreDirty: true });
          }}
          hasPrevious={Boolean(neighbors?.previous)}
          hasNext={Boolean(neighbors?.next)}
          onDirtyChange={setAnnotationDirty}
          onDeleteImages={deleteTestImages}
          onSave={saveAnnotations}
          onCreateClass={createTestClass}
          onImportClasses={importTestClasses}
          onDeleteClass={deleteTestClassById}
          busy={busy}
        />
      </>
    );
  }

  const columns: TableProps<TestDataset>["columns"] = [
    { title: "#", key: "index", width: 48, render: (_value, _item, index) => index + 1 },
    {
      title: "数据集名称",
      key: "name",
      render: (_, item) => (
        <div>
          <Typography.Text strong>{item.name}</Typography.Text>
          <div>
            <AntdTag>{item.version}</AntdTag>
            {item.purpose_tag && <AntdTag color="blue">{TEST_PURPOSE_LABELS[item.purpose_tag]}</AntdTag>}
          </div>
        </div>
      ),
    },
    { title: "任务类型", key: "task_type", width: 110, render: (_, item) => taskLabel(item.task_type) },
    { title: "来源", key: "source", width: 90, render: (_, item) => (item.source === "ftp" ? "FTP 同步" : "本地上传") },
    { title: "图片数", key: "image_count", width: 90, render: (_, item) => item.image_count },
    {
      title: "标注进度",
      key: "progress",
      width: 180,
      render: (_, item) => (
        <Progress percent={item.marked_percent} size="small" status={item.marked_percent >= 100 ? "success" : "active"} format={() => `${item.marked_count}/${item.image_count}`} />
      ),
    },
    {
      title: "状态",
      key: "status",
      width: 110,
      render: (_, item) =>
        item.import_state === "importing" ? (
          <div style={{ width: 150 }}>
            <Progress percent={Math.round(item.import_progress)} size="small" status="active" />
            <AntdButton type="link" size="small" danger disabled={busy} onClick={() => void stopImport(item)}>停止导入</AntdButton>
          </div>
        ) : item.import_state === "failed" ? (
          <Tooltip title={item.import_message ?? "未知错误"}><AntdTag color="red">导入失败</AntdTag></Tooltip>
        ) : item.import_state === "stopped" ? (
          <AntdTag>已停止</AntdTag>
        ) : item.status === "locked" ? (
          <AntdTag color="orange">任务锁定</AntdTag>
        ) : item.marked_percent >= 100 ? (
          <AntdTag color="green">已就绪</AntdTag>
        ) : (
          <AntdTag color="gold">标注中</AntdTag>
        ),
    },
    {
      title: "操作",
      key: "actions",
      width: 240,
      render: (_, item) => (
        <Space size={4}>
          <AntdButton type="link" size="small" disabled={busy || item.import_state === "importing" || !item.image_count} onClick={() => void continueAnnotation(item)}>在线标注</AntdButton>
          <AntdButton type="link" size="small" disabled={busy || item.import_state === "importing"} onClick={() => setUploadTarget(item)}>上传图片</AntdButton>
          <Popconfirm title={`删除测试数据集「${item.name}」？`} description="图片与预期标注会永久删除，不可恢复。" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => void deleteDataset(item)}>
            <AntdButton type="link" size="small" danger disabled={busy || item.import_state === "importing"}>删除</AntdButton>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <main className="panel workspace-panel" style={{ padding: 20 }}>
      <Toast kind="error" message={error} onClose={() => setError("")} />
      <Toast kind="success" message={notice} onClose={() => setNotice("")} />
      {uploadProgress && <UploadProgressToast label="上传测试图片" progress={uploadProgress.progress} />}
      <header style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>算法测试 · 测试数据集</Typography.Title>
        <Typography.Text type="secondary">
          管理独立的测试数据集并标记预期结果。后续「算法服务配置」「测试任务制定」将在本模块内开放。
        </Typography.Text>
      </header>
      <div style={{ marginBottom: 16, display: "flex", justifyContent: "space-between", gap: 12 }}>
        <Space>
          <Typography.Text type="secondary">共 {datasets.length} 个测试数据集</Typography.Text>
        </Space>
        <Space>
          <AntdButton disabled={busy} onClick={() => setFtpOpen(true)}>FTP 同步</AntdButton>
          <AntdButton type="primary" disabled={busy} onClick={() => setCreateOpen(true)}>新建数据集</AntdButton>
        </Space>
      </div>
      <Table<TestDataset>
        rowKey="id"
        columns={columns}
        dataSource={datasets}
        loading={busy && !datasets.length}
        pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
        locale={{ emptyText: "还没有测试数据集，点击右上角「新建数据集」开始" }}
      />

      <Modal
        title="新建测试数据集"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void submitCreate()}
        okText="创建"
        cancelText="取消"
        okButtonProps={{ disabled: busy }}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" initialValues={{ task_type: "detect", purpose_tag: "regression" }}>
          <Form.Item name="name" label="数据集名称" rules={[{ required: true, message: "请输入名称" }]}>
            <AntdInput placeholder="例如：塔筒裂缝-测试集" autoFocus />
          </Form.Item>
          <Form.Item name="task_type" label="任务类型（决定标注工具与校验规则）" rules={[{ required: true }]}>
            <Radio.Group options={TASK_TYPE_OPTIONS} optionType="button" />
          </Form.Item>
          <Form.Item name="purpose_tag" label="用途标签">
            <AntdSelect options={PURPOSE_OPTIONS} allowClear placeholder="可选：回归基线 / 扩充集 / 难例集 / 验收集" />
          </Form.Item>
          <Form.Item name="ftp_dir" label="FTP 分发目录" extra="测试任务执行时图片会上传到该目录，{{image_url}} 占位符替换为 FTP 相对路径。留空使用默认值。">
            <AntdInput placeholder="/ywa-test/（默认按数据集 ID 自动分配）" />
          </Form.Item>
          <Form.Item name="notes" label="备注">
            <AntdInput.TextArea rows={2} placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>

      <UploadImagesModal
        dataset={uploadTarget}
        busy={busy}
        onClose={() => setUploadTarget(undefined)}
        onSubmit={(files) => uploadTarget && void uploadFiles(uploadTarget, files)}
      />

      <FtpImportModal
        open={ftpOpen}
        busy={busy}
        onClose={() => setFtpOpen(false)}
        onSubmit={async (payload) => {
          await run(async () => {
            const created = await api.createTestDatasetFromFtp(payload);
            setFtpOpen(false);
            setDatasets((items) => [created, ...items]);
            setNotice(`已开始从 FTP ${payload.source === "dir" ? "目录" : "压缩包"}建集「${created.name}」，进度见列表。`);
          });
        }}
      />
    </main>
  );
}

/** 从 FTP 目录/压缩包建测试数据集:表单 + 简易 FTP 浏览(zip 选中或目录进入)。 */
function FtpImportModal({ open, busy, onClose, onSubmit }: { open: boolean; busy: boolean; onClose: () => void; onSubmit: (payload: { name: string; task_type: TestTaskType; purpose_tag?: TestPurposeTag | null; notes?: string | null; path: string; source: "zip" | "dir" }) => Promise<void> }) {
  const [form] = Form.useForm();
  const [ftpPath, setFtpPath] = useState("/");
  const [entries, setEntries] = useState<FtpEntry[]>([]);
  const [ftpLoading, setFtpLoading] = useState(false);
  const [ftpError, setFtpError] = useState("");
  const [selected, setSelected] = useState<{ path: string; source: "zip" | "dir" }>();

  const browse = useCallback((path: string) => {
    setFtpLoading(true);
    setFtpError("");
    api.listFtp(path).then((result) => {
      setFtpPath(result.path);
      setEntries(result.entries);
    }).catch((reason: unknown) => {
      setFtpError(reason instanceof Error ? reason.message : "FTP 目录读取失败");
    }).finally(() => setFtpLoading(false));
  }, []);

  useEffect(() => {
    if (open && !entries.length) browse("/");
    if (!open) { setSelected(undefined); setFtpError(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const parentOf = (path: string) => {
    const trimmed = path.replace(/\/+$/, "");
    const index = trimmed.lastIndexOf("/");
    return index <= 0 ? "/" : trimmed.slice(0, index);
  };

  const submit = async () => {
    if (!selected) return;
    const values = await form.validateFields();
    await onSubmit({
      name: values.name,
      task_type: values.task_type,
      purpose_tag: values.purpose_tag ?? null,
      notes: values.notes ?? null,
      path: selected.path,
      source: selected.source,
    });
    form.resetFields();
    setSelected(undefined);
  };

  return (
    <Modal
      title="从 FTP 数据源同步建集"
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      okText="开始同步"
      okButtonProps={{ disabled: busy || ftpLoading || !selected }}
      cancelText="取消"
      width={680}
      destroyOnHidden
    >
      <Alert type="info" showIcon style={{ marginBottom: 12 }} title="复用已配置的 FTP 数据源。支持 YOLO 目录（images/ + labels/，labels 会作为预期标注导入）与 zip 压缩包。" />
      <Form form={form} layout="vertical" initialValues={{ task_type: "detect", purpose_tag: "regression" }}>
        <Flex gap={12} vertical={false}>
          <Form.Item name="name" label="数据集名称" style={{ flex: 1 }} rules={[{ required: true, message: "请输入名称" }]}>
            <AntdInput placeholder="例如：机舱锈蚀-分类测试集" />
          </Form.Item>
          <Form.Item name="task_type" label="任务类型" rules={[{ required: true }]}>
            <AntdSelect options={TASK_TYPE_OPTIONS} style={{ width: 130 }} />
          </Form.Item>
          <Form.Item name="purpose_tag" label="用途标签" initialValue="regression">
            <AntdSelect options={PURPOSE_OPTIONS} allowClear style={{ width: 130 }} />
          </Form.Item>
        </Flex>
      </Form>
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}>
        <Space style={{ marginBottom: 8 }}>
          <AntdButton size="small" disabled={ftpLoading || ftpPath === "/"} onClick={() => browse(parentOf(ftpPath))}>↑ 上级</AntdButton>
          <AntdInput size="small" style={{ width: 380 }} value={ftpPath} readOnly />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{ftpLoading ? "读取中…" : `${entries.length} 项`}</Typography.Text>
        </Space>
        {ftpError && <Typography.Text type="danger" style={{ fontSize: 12 }}>{ftpError}</Typography.Text>}
        <div style={{ maxHeight: 240, overflowY: "auto" }}>
          {entries.map((entry) => (
            <AntdButton
              key={entry.path}
              type="text"
              block
              style={{ justifyContent: "flex-start", textAlign: "left" }}
              className={selected?.path === entry.path ? "ftp-entry-selected" : undefined}
              onClick={() => {
                if (entry.is_dir) {
                  setSelected(undefined);
                  browse(entry.path);
                } else if (entry.name.toLowerCase().endsWith(".zip")) {
                  setSelected({ path: entry.path, source: "zip" });
                }
              }}
            >
              {entry.is_dir ? "📁" : entry.name.toLowerCase().endsWith(".zip") ? "🗜" : "📄"} {entry.name}
              {selected?.path === entry.path && <AntdTag color="blue" style={{ marginInlineStart: 8 }}>已选中</AntdTag>}
            </AntdButton>
          ))}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {selected
            ? `已选择：${selected.path}${selected.source === "zip" ? "（压缩包）" : ""}`
            : "点击目录进入，点击 zip 文件选中；也可以直接选中当前目录"}
        </Typography.Text>
        <div style={{ marginTop: 4 }}>
          <AntdButton size="small" type={selected?.path === ftpPath ? "primary" : "default"} disabled={ftpLoading} onClick={() => setSelected({ path: ftpPath, source: "dir" })}>选用当前目录</AntdButton>
        </div>
      </div>
    </Modal>
  );
}

function UploadImagesModal({ dataset, busy, onClose, onSubmit }: { dataset: TestDataset | undefined; busy: boolean; onClose: () => void; onSubmit: (files: File[]) => void }) {
  const [fileList, setFileList] = useState<Array<{ originFileObj?: File }>>([]);
  useEffect(() => { if (!dataset) setFileList([]); }, [dataset]);
  if (!dataset) return null;
  return (
    <Modal
      title={`上传测试图片 · ${dataset.name}`}
      open
      onCancel={onClose}
      onOk={() => onSubmit(fileList.map((item) => item.originFileObj).filter((file): file is File => Boolean(file)))}
      okText={`上传 ${fileList.length || ""} 张`}
      okButtonProps={{ disabled: busy || !fileList.length }}
      cancelText="取消"
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title="同名内容（MD5）会自动去重。上传后即可进入「在线标注」标记预期结果。"
      />
      <Upload.Dragger
        multiple
        listType="picture"
        beforeUpload={() => false}
        fileList={fileList as never}
        onChange={({ fileList: next }) => setFileList(next)}
        accept="image/*"
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">拖拽图片到此处，或点击选择</p>
        <p className="ant-upload-hint">支持 JPG / PNG / BMP / WEBP</p>
      </Upload.Dragger>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <MoreOutlined /> 任务类型：{taskLabel(dataset.task_type)}
      </Typography.Text>
    </Modal>
  );
}
