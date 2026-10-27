import type { ReactNode } from "react";
import type { AppLocale } from "../locale";
import { localeText } from "../locale";

export type StarterSection = "workspace" | "training" | "models" | "agent" | "logs" | "ftp" | "datasources" | "plugin-manager" | `plugin:${string}` | "settings";

interface Props {
  active: StarterSection;
  onNavigate: (section: StarterSection) => void;
  locale?: AppLocale;
  focusMode?: boolean;
  plugins?: Array<{ id: string; name: string; icon: string | null }>;
  children: ReactNode;
}

const navigation: Array<{ id: StarterSection; label: string; icon: ReactNode }> = [
  { id: "datasources", label: "数据源", icon: <SourceIcon /> },
  { id: "workspace", label: "数据集", icon: <DatasetIcon /> },
  { id: "training", label: "训练", icon: <TrainingIcon /> },
  { id: "models", label: "模型", icon: <ModelIcon /> },
  { id: "agent", label: "智能体", icon: <AgentIcon /> },
  { id: "logs", label: "日志", icon: <LogsIcon /> },
  { id: "ftp", label: "FTP 管理", icon: <FtpIcon /> },
  { id: "settings", label: "设置", icon: <SettingsIcon /> },
];

/** 应用外壳：顶栏 + 左侧导航 + 内容区。 */
export function StarterShell({ active, onNavigate, locale = "zh", focusMode = false, plugins = [], children }: Props) {
  const text = localeText[locale];
  const labels: Partial<Record<StarterSection, string>> = {
    workspace: text.datasets,
    training: text.training,
    models: text.models,
    agent: text.agent,
    settings: text.settingsGroup,
    logs: text.logs,
    ftp: text.ftp,
    datasources: text.dataSources,
  };
  return (
    <div className={focusMode ? "starter-shell focus-mode" : "starter-shell"}>
      <div className="starter-layout">
        <aside className="starter-sidebar">
          <nav className="starter-menu" aria-label={text.mainNav}>
            <span className="starter-menu-group-label">{text.workspaceGroup}</span>
            {navigation.slice(0, 7).map((item) => <NavigationButton key={item.id} item={item} active={active} labels={labels} onNavigate={onNavigate} />)}
            <span className="starter-menu-group-label">{text.pluginsGroup}</span>
            {plugins.map((plugin) => (
              <button key={`plugin-${plugin.id}`} className={active === `plugin:${plugin.id}` ? "starter-menu-item active" : "starter-menu-item"} title={plugin.name} onClick={() => onNavigate(`plugin:${plugin.id}`)}>
                <PluginIcon /><span>{plugin.name}</span>
              </button>
            ))}
            <button className={active === "plugin-manager" ? "starter-menu-item active" : "starter-menu-item"} title="插件管理" onClick={() => onNavigate("plugin-manager")}>
              <PluginIcon /><span>插件管理</span>
            </button>
            <span className="starter-menu-group-label">{text.settingsGroup}</span>
            {navigation.slice(7).map((item) => <NavigationButton key={item.id} item={item} active={active} labels={labels} onNavigate={onNavigate} />)}
          </nav>
        </aside>
        <div className="starter-main">{children}</div>
      </div>
    </div>
  );
}

function NavigationButton({ item, active, labels, onNavigate }: { item: (typeof navigation)[number]; active: StarterSection; labels: Partial<Record<StarterSection, string>>; onNavigate: (section: StarterSection) => void }) {
  const label = labels[item.id] ?? item.label;
  return <button className={active === item.id ? "starter-menu-item active" : "starter-menu-item"} title={label} onClick={() => onNavigate(item.id)}>
    {item.icon}<span>{label}</span>
  </button>;
}

function PluginIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 3 1.4 3.2L14.6 7.6 18 9l-3.4 1.4L13.2 13 12 15l-1.2-2-1.4-2.6L6 9l3.4-1.4L10.8 5 10 3Z" /><path d="M17.5 14.5 18.4 16.6 20.5 17.5 18.4 18.4 17.5 20.5 16.6 18.4 14.5 17.5 16.6 16.6 17.5 14.5Z" /><path d="M6 15.5 6.7 17.3 8.5 18 6.7 18.7 6 20.5 5.3 18.7 3.5 18 5.3 17.3 6 15.5Z" /></svg>; }
function DatasetIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z" /><path d="m7.5 15 2.5-3 2 2.2 1.7-1.8 2.8 3.1" /><circle cx="9" cy="9" r="1.2" /></svg>; }
function TrainingIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18V9m5 9V5m5 13v-7m4 7V8" /><path d="M3.5 20.5h17" /></svg>; }
function ModelIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 7 4v10l-7 4-7-4V7l7-4Z" /><path d="m5 7 7 4 7-4M12 11v10" /></svg>; }
function SettingsIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19 13.5 1.2 1-.2 1.7-1.5 1-1.7-.6-1 1.1.1 1.8-1.5.8-1.4-1.1h-1.5L10 20.3l-1.6-.8.1-1.8-1-1.1-1.7.6-1.5-1 .2-1.7 1.2-1v-1.5l-1.2-1 .2-1.7 1.5-1 1.7.6 1-1.1-.1-1.8L10 5l1.4 1.1h1.5L14.3 5l1.6.8-.1 1.8 1 1.1 1.7-.6 1.5 1-.2 1.7-1.2 1Z" /></svg>; }
function FtpIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="6" rx="1.5" /><rect x="4" y="14" width="16" height="6" rx="1.5" /><circle cx="8" cy="7" r="1" /><circle cx="8" cy="17" r="1" /></svg>; }
function SourceIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 4 8l8 4.5L20 8l-8-4.5Z" /><path d="m4 12.5 8 4.5 8-4.5" /><path d="m4 17 8 4.5 8-4.5" /></svg>; }
function LogsIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5h12v15H6z" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>; }
function AgentIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z" /><path d="M5.5 19c.8-3.2 3.3-5 6.5-5s5.7 1.8 6.5 5" /><path d="M18 8.5h2.5M3.5 8.5H6M12 2v1.5" /></svg>; }
