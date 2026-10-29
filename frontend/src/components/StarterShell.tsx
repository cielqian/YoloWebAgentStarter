import type { ReactNode } from "react";
import { Layout, Menu } from "antd";
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
          <Menu
            mode="inline"
            selectedKeys={[active]}
            items={menuItems}
            onClick={({ key }) => onNavigate(key as StarterSection)}
            className="starter-antd-menu"
          />
        </Sider>
        <Layout>
          <Header className="starter-antd-header">
            <span className="starter-antd-header-title">{currentLabel(active, labels)}</span>
          </Header>
          <Content className="starter-antd-content">{children}</Content>
        </Layout>
      </Layout>
    </div>
  );
}

const SETTINGS_LABELS: Record<string, string> = {
  "settings-llm": "Agent LLM",
  "settings-sam": "SAM 辅助",
  "settings-ftp": "FTP 连接",
  "settings-nodes": "Agent 配置",
  "settings-weights": "基础权重",
  "settings-basedata": "基础数据",
  "settings-webhook": "Webhook 通知",
  "settings-language": "语言",
};

function currentLabel(active: StarterSection, labels: Partial<Record<StarterSection, string>>): string {
  if (active.startsWith("plugin:")) return "插件";
  if (active === "plugin-manager") return "插件管理";
  if (active in SETTINGS_LABELS) return `设置 · ${SETTINGS_LABELS[active]}`;
  return labels[active] ?? "";
}

function DatasetIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z" /><path d="m7.5 15 2.5-3 2 2.2 1.7-1.8 2.8 3.1" /><circle cx="9" cy="9" r="1.2" /></svg>; }
function ModelIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 7 4v10l-7 4-7-4V7l7-4Z" /><path d="m5 7 7 4 7-4M12 11v10" /></svg>; }
function FtpIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="6" rx="1.5" /><rect x="4" y="14" width="16" height="6" rx="1.5" /><circle cx="8" cy="7" r="1" /><circle cx="8" cy="17" r="1" /></svg>; }
function LogsIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5h12v15H6z" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>; }
