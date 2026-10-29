import type { ReactNode } from "react";
import { Flex, Layout, Menu } from "antd";
import type { AppLocale } from "../locale";
import { localeText } from "../locale";

export type StarterSection = "workspace" | "training" | "models" | "agent" | "logs" | "ftp" | "datasources" | "plugin-manager" | `plugin:${string}` | "settings-llm" | "settings-sam" | "settings-ftp" | "settings-nodes" | "settings-weights" | "settings-basedata" | "settings-webhook" | "settings-language";

interface Props {
  active: StarterSection;
  onNavigate: (section: StarterSection) => void;
  locale?: AppLocale;
  focusMode?: boolean;
  plugins?: Array<{ id: string; name: string; icon: string | null }>;
  children: ReactNode;
}

const Sider = Layout.Sider;
const Header = Layout.Header;
const Content = Layout.Content;

/** 应用外壳:antd Layout + Sider + Header + Content。 */
export function StarterShell({ active, onNavigate, locale = "zh", focusMode = false, plugins = [], children }: Props) {
  const text = localeText[locale];
  const labels: Partial<Record<string, string>> = {
    workspace: text.datasets,
    training: text.training,
    models: text.models,
    agent: text.agent,
    settings: text.settingsGroup,
    logs: text.logs,
    ftp: text.ftp,
    datasources: text.dataSources,
  };

  const workspaceItems = [
    { key: "datasources", label: labels.datasources ?? "数据源" },
    { key: "workspace", label: labels.workspace ?? "数据集" },
    { key: "training", label: labels.training ?? "训练" },
    { key: "models", label: labels.models ?? "模型" },
    { key: "agent", label: labels.agent ?? "智能体" },
    { key: "logs", label: labels.logs ?? "日志" },
    { key: "ftp", label: labels.ftp ?? "FTP 管理" },
  ];

  const pluginItems = [
    ...plugins.map((plugin) => ({ key: `plugin:${plugin.id}`, label: plugin.name })),
    { key: "plugin-manager", label: "插件管理" },
  ];

  const settingsItems = [
    { key: "settings-llm", label: locale === "zh" ? "Agent LLM" : "Agent LLM" },
    { key: "settings-sam", label: locale === "zh" ? "SAM 辅助" : "SAM Assist" },
    { key: "settings-ftp", label: locale === "zh" ? "FTP 连接" : "FTP Connection" },
    { key: "settings-nodes", label: locale === "zh" ? "Agent 配置" : "Agent Nodes" },
    { key: "settings-weights", label: locale === "zh" ? "基础权重" : "Base Weights" },
    { key: "settings-basedata", label: locale === "zh" ? "基础数据" : "Base Data" },
    { key: "settings-webhook", label: locale === "zh" ? "Webhook 通知" : "Webhook" },
    { key: "settings-language", label: locale === "zh" ? "语言" : "Language" },
  ];

  const menuItems = [
    { type: "group" as const, label: text.workspaceGroup, children: workspaceItems },
    ...(pluginItems.length ? [{ type: "group" as const, label: text.pluginsGroup, children: pluginItems }] : []),
    { type: "group" as const, label: text.settingsGroup, children: settingsItems },
  ];

  return (
    <div className={focusMode ? "starter-shell focus-mode" : "starter-shell"}>
      <Layout className="starter-antd-layout">
        <Sider width={220} className="starter-antd-sider" breakpoint="lg" collapsedWidth={0}>
          <div className="starter-antd-logo">
            <span className="starter-antd-logo-badge">YWA</span>
            <span className="starter-antd-logo-text">YOLO 训练平台</span>
          </div>
          <div className="starter-antd-menu-scroll">
            <Menu
              mode="inline"
              selectedKeys={[active]}
              items={menuItems}
              onClick={({ key }) => onNavigate(key as StarterSection)}
              className="starter-antd-menu"
            />
          </div>
        </Sider>
        <Layout>
          <Header className="starter-antd-header">
            <Flex align="baseline" gap={12}>
              <span className="starter-antd-header-title">{currentInfo(active, labels).title}</span>
              <span className="starter-antd-header-desc">{currentInfo(active, labels).description}</span>
            </Flex>
          </Header>
          <Content className="starter-antd-content">{children}</Content>
        </Layout>
      </Layout>
    </div>
  );
}

const SECTION_INFO: Record<string, { title: string; description: string }> = {
  datasources: { title: "数据源", description: "管理原始图片素材池,支持 FTP 同步、本地上传与多值标签筛选" },
  workspace: { title: "数据集", description: "在这里创建、导入和管理你的数据集。" },
  training: { title: "训练", description: "训练任务下发、实时进度与历史记录" },
  models: { title: "模型", description: "训练产出的受管模型,支持 PT/ONNX/OM 格式转换" },
  agent: { title: "智能体", description: "AI 助手对话,支持数据问答与受管任务提交" },
  logs: { title: "日志", description: "后端运行日志与插件日志排查" },
  ftp: { title: "FTP 管理", description: "浏览、上传与删除 FTP 服务器上的文件" },
  "plugin-manager": { title: "插件管理", description: "安装/卸载插件包,查看插件运行日志" },
  "settings-llm": { title: "Agent LLM", description: "Provider、模型与 API Key" },
  "settings-sam": { title: "SAM 辅助", description: "模型、设备与建议方式" },
  "settings-ftp": { title: "FTP 连接", description: "FTP 服务器连接配置与连通性测试" },
  "settings-nodes": { title: "Agent 配置", description: "训练与 OM 转换节点的注册与管理" },
  "settings-weights": { title: "基础权重", description: "预置 .pt 权重上传与删除" },
  "settings-basedata": { title: "基础数据", description: "全局类别库、标签库与素材类型管理" },
  "settings-webhook": { title: "Webhook 通知", description: "训练生命周期事件 HTTP 回调配置" },
  "settings-language": { title: "语言", description: "工作台显示语言偏好" },
};

function currentInfo(active: StarterSection, labels: Partial<Record<string, string>>): { title: string; description: string } {
  if (active.startsWith("plugin:")) return { title: "插件", description: "" };
  if (active in SECTION_INFO) {
    const info = SECTION_INFO[active];
    return active.startsWith("settings-") ? { title: `设置 · ${info.title}`, description: info.description } : info;
  }
  const label = labels[active] ?? "";
  return { title: label, description: SECTION_INFO[active]?.description ?? "" };
}

function DatasetIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z" /><path d="m7.5 15 2.5-3 2 2.2 1.7-1.8 2.8 3.1" /><circle cx="9" cy="9" r="1.2" /></svg>; }
function ModelIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 7 4v10l-7 4-7-4V7l7-4Z" /><path d="m5 7 7 4 7-4M12 11v10" /></svg>; }
function FtpIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="6" rx="1.5" /><rect x="4" y="14" width="16" height="6" rx="1.5" /><circle cx="8" cy="7" r="1" /><circle cx="8" cy="17" r="1" /></svg>; }
function LogsIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5h12v15H6z" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>; }
