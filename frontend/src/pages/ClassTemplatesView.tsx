import { useEffect, useState } from "react";
import {
  App as AntdApp,
  Button as AntdButton,
  Card,
  ColorPicker,
  Flex,
  Form as AntdForm,
  Input as AntdInput,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  type TableProps,
} from "antd";
import { PlusOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import type { ClassTemplate, MaterialType, TagTemplate } from "../types";

const { Text } = Typography;

function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : "操作失败，请检查后端服务。"; }

/** 翻译接口未产出提示词时，按 source 给出可操作的提示。 */
export function sam3TranslateMessage(result: { sam3_prompt: string | null; source: string }): string {
  if (result.sam3_prompt) return "";
  if (result.source === "llm_failed") return "LLM 翻译调用失败，请到设置页检查 LLM 连接，或手动填写英文提示词。";
  if (result.source === "llm_invalid") return "LLM 返回的内容不是有效的英文提示词，请手动填写。";
  return "自动翻译暂不可用（内置词典未覆盖且未配置可用 LLM），请手动填写英文提示词。";
}

const CLASS_COLORS = [
  "#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7",
  "#14b8a6", "#f97316", "#06b6d4", "#ec4899", "#84cc16",
  "#6366f1", "#eab308", "#10b981", "#f43f5e", "#0ea5e9",
  "#8b5cf6", "#d946ef", "#facc15", "#4ade80", "#fb923c",
];

const COLOR_PRESETS = [{ label: "常用色", colors: CLASS_COLORS, defaultOpen: true }];

function formatTime(value: string): string {
  return value ? value.slice(0, 19).replace("T", " ") : "—";
}

export function ClassTemplatesView() {
  return (
    <main className="class-library-page">

      <Tabs
        defaultActiveKey="classes"
        items={[
          { key: "classes", label: "类别库", children: <ClassLibraryPanel /> },
          { key: "tags", label: "标签库", children: <TagLibraryPanel /> },
          { key: "materials", label: "素材类型", children: <MaterialTypePanel /> },
        ]}
      />
    </main>
  );
}

type ClassFormValues = { name: string; color: string; sam3Prompt?: string };

function ClassLibraryPanel() {
  const { message } = AntdApp.useApp();
  const [templates, setTemplates] = useState<ClassTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ClassTemplate | null>(null);
  const [translating, setTranslating] = useState(false);
  const [form] = AntdForm.useForm<ClassFormValues>();

  const refresh = () =>
    api.listClassTemplates()
      .then(setTemplates)
      .catch((reason: unknown) => message.error(errorMessage(reason)))
      .finally(() => setLoading(false));
  useEffect(() => { void refresh(); }, []);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ color: CLASS_COLORS[templates.length % CLASS_COLORS.length] });
    setDialogOpen(true);
  };

  const openEdit = (item: ClassTemplate) => {
    setEditing(item);
    form.setFieldsValue({ name: item.name, color: item.color, sam3Prompt: item.sam3_prompt ?? "" });
    setDialogOpen(true);
  };

  const autoTranslate = async () => {
    const source = (form.getFieldValue("name") as string | undefined)?.trim();
    if (!source) return;
    setTranslating(true);
    try {
      const result = await api.translateSam3Prompt(source);
      if (result.sam3_prompt) form.setFieldsValue({ sam3Prompt: result.sam3_prompt });
      const hint = sam3TranslateMessage(result);
      if (hint) message.warning(hint);
    } catch (reason) {
      message.error(errorMessage(reason));
    } finally {
      setTranslating(false);
    }
  };

  const submit = async (values: ClassFormValues) => {
    const prompt = values.sam3Prompt?.trim() || null;
    try {
      if (editing) {
        await api.updateClassTemplate(editing.id, { name: values.name.trim(), color: values.color, sam3_prompt: prompt ?? undefined });
        message.success(`类别“${values.name.trim()}”已更新`);
      } else {
        await api.createClassTemplate({ name: values.name.trim(), color: values.color, ...(prompt ? { sam3_prompt: prompt } : {}) });
        message.success(`已新增类别“${values.name.trim()}”`);
      }
      setDialogOpen(false);
      await refresh();
    } catch (reason) {
      message.error(errorMessage(reason));
    }
  };

  const remove = async (item: ClassTemplate) => {
    try {
      await api.deleteClassTemplate(item.id);
      message.success(`类别“${item.name}”已从类别库删除（数据集中的既有类别不受影响）`);
      await refresh();
    } catch (reason) {
      message.error(errorMessage(reason));
    }
  };

  return (
    <>
      <Flex justify="flex-end" style={{ marginBottom: 16 }}>
        <AntdButton type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增类别</AntdButton>
      </Flex>
      {loading ? (
        <Text type="secondary">加载中…</Text>
      ) : !templates.length ? (
        <Card>类别库还是空的。先在这里沉淀常用类别，标注时即可一键导入数据集，不必每个数据集重复录入。</Card>
      ) : (
        <Flex wrap gap={12} align="stretch">
          {templates.map((item) => (
            <Card
              key={item.id}
              size="small"
              style={{ width: 272 }}
              title={<Space size={8}><span style={{ width: 12, height: 12, borderRadius: 4, background: item.color, display: "inline-block" }} />{item.name}</Space>}
            >
              <p style={{ margin: "0 0 4px" }}>
                <Text type="secondary" style={{ fontSize: 12 }}>SAM3</Text>{" "}
                {item.sam3_prompt ? <Text code>{item.sam3_prompt}</Text> : <Text type="secondary" style={{ fontSize: 12 }}>未设置英文提示词</Text>}
              </p>
              <Space size="small" style={{ marginTop: 8 }}>
                <AntdButton type="link" size="small" onClick={() => openEdit(item)}>编辑</AntdButton>
                <Popconfirm title={`删除类别“${item.name}”？`} description="只从类别库移除模板，已导入数据集的类别和标注不受影响。" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => void remove(item)}>
                  <AntdButton type="link" size="small" danger>删除</AntdButton>
                </Popconfirm>
              </Space>
            </Card>
          ))}
        </Flex>
      )}

      <Modal
        title={editing ? "编辑类别" : "新增类别"}
        open={dialogOpen}
        onCancel={() => setDialogOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        onOk={() => void form.submit()}
      >
        <AntdForm form={form} layout="vertical" onFinish={(values) => void submit(values)} style={{ marginTop: 12 }} initialValues={{ color: CLASS_COLORS[0] }}>
          <AntdForm.Item name="name" label="类别名称" rules={[{ required: true, message: "请输入类别名称" }]}>
            <AntdInput placeholder="例如：安全帽 / helmet" autoFocus />
          </AntdForm.Item>
          <AntdForm.Item name="color" label="颜色" initialValue={CLASS_COLORS[0]}>
            <ColorPicker presets={COLOR_PRESETS} disabledAlpha showText format="hex" />
          </AntdForm.Item>
          <AntdForm.Item label="SAM3 英文提示词（实例分割可选）" style={{ marginBottom: 0 }}>
            <Flex gap={8}>
              {/* 提示词输入与"自动翻译"按钮并排;按钮可用性跟随名称输入 */}
              <AntdForm.Item name="sam3Prompt" noStyle>
                <AntdInput placeholder="例如：helmet，留空则按名称自动生成" />
              </AntdForm.Item>
              <AntdButton icon={<ThunderboltOutlined />} loading={translating} disabled={!form.getFieldValue("name")?.trim()} onClick={() => void autoTranslate()}>自动翻译</AntdButton>
            </Flex>
          </AntdForm.Item>
        </AntdForm>
      </Modal>
    </>
  );
}

type TagFormValues = { name: string; color: string; values?: string[]; description?: string };

function TagLibraryPanel() {
  const { message } = AntdApp.useApp();
  const [tags, setTags] = useState<TagTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TagTemplate | null>(null);
  const [form] = AntdForm.useForm<TagFormValues>();

  const refresh = () =>
    api.listTagTemplates()
      .then(setTags)
      .catch((reason: unknown) => message.error(errorMessage(reason)))
      .finally(() => setLoading(false));
  useEffect(() => { void refresh(); }, []);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ color: CLASS_COLORS[tags.length % CLASS_COLORS.length] });
    setDialogOpen(true);
  };

  const openEdit = (item: TagTemplate) => {
    setEditing(item);
    form.setFieldsValue({ name: item.name, color: item.color, values: item.values ?? [], description: item.description ?? "" });
    setDialogOpen(true);
  };

  const submit = async (values: TagFormValues) => {
    const payload = {
      name: values.name.trim(),
      color: values.color,
      values: values.values?.length ? values.values : null,
      description: values.description?.trim() || null,
    };
    try {
      if (editing) {
        await api.updateTagTemplate(editing.id, payload);
        message.success(`标签“${payload.name}”已更新`);
      } else {
        await api.createTagTemplate(payload);
        message.success(`已新增标签“${payload.name}”`);
      }
      setDialogOpen(false);
      await refresh();
    } catch (reason) {
      message.error(errorMessage(reason));
    }
  };

  const remove = async (item: TagTemplate) => {
    try {
      await api.deleteTagTemplate(item.id);
      message.success(`已删除标签“${item.name}”`);
      await refresh();
    } catch (reason) {
      message.error(errorMessage(reason));
    }
  };

  const columns: TableProps<TagTemplate>["columns"] = [
    { title: "#", key: "_index", width: 50, render: (_, __, index) => index + 1 },
    {
      title: "标签",
      dataIndex: "name",
      key: "name",
      render: (_, item) => (
        <Space size={8}>
          <span style={{ width: 12, height: 12, borderRadius: 4, background: item.color, display: "inline-block" }} />
          {item.name}
        </Space>
      ),
    },
    {
      title: "枚举取值",
      dataIndex: "values",
      key: "values",
      render: (values: string[] | null) =>
        values?.length ? <Space size={4} wrap>{values.map((value) => <Tag key={value}>{value}</Tag>)}</Space> : <Text type="secondary">—</Text>,
    },
    { title: "备注", dataIndex: "description", key: "description", render: (value: string | null) => value || <Text type="secondary">—</Text> },
    { title: "更新时间", dataIndex: "updated_at", key: "updated_at", width: 170, render: (value: string) => formatTime(value) },
    {
      title: "操作",
      key: "actions",
      width: 140,
      render: (_, item) => (
        <Space size="small">
          <AntdButton type="link" size="small" onClick={() => openEdit(item)}>编辑</AntdButton>
          <Popconfirm title={`删除标签“${item.name}”？`} description="只删除标签库模板;数据源已使用的标签和图片标注不受影响。" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => void remove(item)}>
            <AntdButton type="link" size="small" danger>删除</AntdButton>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Flex justify="flex-end" style={{ marginBottom: 16 }}>
        <AntdButton type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增标签</AntdButton>
      </Flex>
      <Table<TagTemplate>
        rowKey="id"
        columns={columns}
        dataSource={tags}
        loading={loading}
        pagination={false}
        size="middle"
        locale={{ emptyText: "标签库还是空的。新增标签(如“光线=强/弱”)后,数据源打标界面会直接使用。" }}
      />

      <Modal
        title={editing ? "编辑标签" : "新增标签"}
        open={dialogOpen}
        onCancel={() => setDialogOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        onOk={() => void form.submit()}
      >
        <AntdForm form={form} layout="vertical" onFinish={(values) => void submit(values)} style={{ marginTop: 12 }} initialValues={{ color: CLASS_COLORS[0] }}>
          <AntdForm.Item name="name" label="标签名" rules={[{ required: true, message: "请输入标签名" }]}>
            <AntdInput placeholder="例如：光线" autoFocus />
          </AntdForm.Item>
          <AntdForm.Item name="color" label="颜色" initialValue={CLASS_COLORS[0]}>
            <ColorPicker presets={COLOR_PRESETS} disabledAlpha showText format="hex" />
          </AntdForm.Item>
          <AntdForm.Item name="values" label="枚举取值" tooltip="选填。填写后打标时可选具体取值(如 强/弱)，回车或逗号分隔">
            <Select mode="tags" placeholder="输入后回车，如：强、弱" tokenSeparators={[",", "，", "、"]} open={false} suffixIcon={null} />
          </AntdForm.Item>
          <AntdForm.Item name="description" label="备注">
            <AntdInput placeholder="选填" />
          </AntdForm.Item>
        </AntdForm>
      </Modal>
    </>
  );
}

function MaterialTypePanel() {
  const { message } = AntdApp.useApp();
  const [types, setTypes] = useState<MaterialType[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MaterialType | null>(null);
  const [form] = AntdForm.useForm<{ name: string; description?: string }>();

  const refresh = () =>
    api.listMaterialTypes()
      .then(setTypes)
      .catch((reason: unknown) => message.error(errorMessage(reason)))
      .finally(() => setLoading(false));
  useEffect(() => { void refresh(); }, []);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setDialogOpen(true);
  };

  const openEdit = (item: MaterialType) => {
    setEditing(item);
    form.setFieldsValue({ name: item.name, description: item.description ?? "" });
    setDialogOpen(true);
  };

  const submit = async (values: { name: string; description?: string }) => {
    const description = values.description?.trim() || null;
    try {
      if (editing) {
        await api.updateMaterialType(editing.id, { name: values.name.trim(), description });
        message.success(`素材类型“${values.name.trim()}”已更新`);
      } else {
        await api.createMaterialType({ name: values.name.trim(), description });
        message.success(`已新增素材类型“${values.name.trim()}”`);
      }
      setDialogOpen(false);
      await refresh();
    } catch (reason) {
      message.error(errorMessage(reason));
    }
  };

  const remove = async (item: MaterialType) => {
    try {
      await api.deleteMaterialType(item.id);
      message.success(`已删除素材类型“${item.name}”（数据源上的引用已同步清理）`);
      await refresh();
    } catch (reason) {
      message.error(errorMessage(reason));
    }
  };

  const columns: TableProps<MaterialType>["columns"] = [
    { title: "#", key: "_index", width: 50, render: (_, __, index) => index + 1 },
    { title: "素材类型", dataIndex: "name", key: "name" },
    { title: "备注", dataIndex: "description", key: "description", render: (value: string | null) => value || <Text type="secondary">—</Text> },
    { title: "更新时间", dataIndex: "updated_at", key: "updated_at", width: 180, render: (value: string) => formatTime(value) },
    {
      title: "操作",
      key: "actions",
      width: 140,
      render: (_, item) => (
        <Space size="small">
          <AntdButton type="link" size="small" onClick={() => openEdit(item)}>编辑</AntdButton>
          <Popconfirm title={`删除素材类型“${item.name}”？`} description="数据源上已选择的该类型会同步移除。" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => void remove(item)}>
            <AntdButton type="link" size="small" danger>删除</AntdButton>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Flex justify="flex-end" style={{ marginBottom: 16 }}>
        <AntdButton type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增素材类型</AntdButton>
      </Flex>
      <Table<MaterialType>
        rowKey="id"
        columns={columns}
        dataSource={types}
        loading={loading}
        pagination={false}
        size="middle"
        locale={{ emptyText: "素材类型库还是空的。新增类型（如“可见光图片 / 红外视频”）后，数据源即可多选打标。" }}
      />
      <Modal
        title={editing ? "编辑素材类型" : "新增素材类型"}
        open={dialogOpen}
        onCancel={() => setDialogOpen(false)}
        cancelText="取消"
        okText="保存"
        okButtonProps={{ autoFocus: true }}
        destroyOnHidden
        onOk={() => void form.submit()}
        confirmLoading={false}
      >
        <AntdForm form={form} layout="vertical" onFinish={(values) => void submit(values)} style={{ marginTop: 12 }}>
          <AntdForm.Item name="name" label="类型名称" rules={[{ required: true, message: "请输入类型名称" }, { max: 255, message: "名称过长" }]}>
            <AntdInput placeholder="例如：可见光图片" autoFocus />
          </AntdForm.Item>
          <AntdForm.Item name="description" label="备注">
            <AntdInput placeholder="选填" />
          </AntdForm.Item>
        </AntdForm>
      </Modal>
    </>
  );
}
