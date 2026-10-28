import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { Toast } from "../components/Toast";
import type { PluginLogEntry, RuntimeLogResponse } from "../types";
import type { AppLocale } from "../locale";

const text = {
  zh: {
    eyebrow: "OPERATIONS", title: "日志", subtitle: "查看后端运行日志与插件日志，定位训练、标注、服务和插件问题。",
    sourceRuntime: "运行日志", sourcePlugins: "插件日志", refresh: "刷新", search: "搜索日志内容…", all: "全部", lines: "行数",
    viewer: "运行日志", path: "日志文件", empty: "暂无日志。", loaded: "已加载", copy: "复制路径", copied: "路径已复制",
    total: "总行数", info: "信息", warn: "警告", error: "错误",
    pluginViewer: "插件运行日志", pluginPick: "选择插件", pluginNone: "还没有带运行日志的插件（安装含后端的插件后，其子进程日志会出现在这里）。", pluginDownload: "下载完整日志", pluginSize: "大小",
  },
  en: {
    eyebrow: "OPERATIONS", title: "Logs", subtitle: "Review backend runtime logs and plugin logs for training, annotation, service, and plugin issues.",
    sourceRuntime: "Runtime logs", sourcePlugins: "Plugin logs", refresh: "Refresh", search: "Search log content…", all: "All", lines: "Lines",
    viewer: "Runtime logs", path: "Log file", empty: "No logs yet.", loaded: "Loaded", copy: "Copy path", copied: "Path copied",
    total: "Total", info: "Info", warn: "Warnings", error: "Errors",
    pluginViewer: "Plugin runtime log", pluginPick: "Plugin", pluginNone: "No plugins with logs yet. After installing a plugin with a backend, its subprocess log appears here.", pluginDownload: "Download full log", pluginSize: "Size",
  },
} as const;

type Source = "runtime" | "plugins";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function LogsView({ locale }: { locale: AppLocale }) {
  const copy = text[locale];
  const [source, setSource] = useState<Source>("runtime");
  const [result, setResult] = useState<RuntimeLogResponse>({ path: "", level: null, lines: [] });
  const [level, setLevel] = useState("");
  const [lineCount, setLineCount] = useState(300);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [plugins, setPlugins] = useState<PluginLogEntry[]>([]);
  const [pluginId, setPluginId] = useState("");

  const load = async () => {
    setLoading(true); setError("");
    try {
      if (source === "plugins") {
        const listed = await api.listPluginLogs();
        setPlugins(listed.items);
        const current = listed.items.some((item) => item.plugin_id === pluginId) ? pluginId : listed.items[0]?.plugin_id ?? "";
        setPluginId(current);
        setResult(current
          ? await api.pluginLogTail(current, lineCount)
          : { path: "", level: null, lines: [] });
      } else {
        setResult(await api.runtimeLogs({ lines: lineCount, level: level || undefined }));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, [source, level, lineCount]);
  useEffect(() => { if (source === "plugins" && pluginId) void load(); }, [pluginId]);
  const visibleLines = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? result.lines.filter((line) => line.toLowerCase().includes(query)) : result.lines;
  }, [result.lines, search]);
  const counts = useMemo(() => ({ info: result.lines.filter((line) => line.includes(" INFO ")).length, warn: result.lines.filter((line) => line.includes(" WARNING ")).length, error: result.lines.filter((line) => line.includes(" ERROR ") || line.includes("Traceback")).length }), [result.lines]);
  const copyPath = async () => { if (result.path) await navigator.clipboard?.writeText(result.path); };
  const selectedPlugin = plugins.find((item) => item.plugin_id === pluginId);

  return <main className="logs-layout">
    <header className="logs-head"><div><span className="eyebrow">{copy.eyebrow}</span><h1>{copy.title}</h1><p>{copy.subtitle}</p></div><div className="header-actions">
      <div className="log-levels logs-source-toggle" role="tablist" aria-label="log source">
        <button role="tab" aria-selected={source === "runtime"} className={source === "runtime" ? "active" : ""} onClick={() => setSource("runtime")}>{copy.sourceRuntime}</button>
        <button role="tab" aria-selected={source === "plugins"} className={source === "plugins" ? "active" : ""} onClick={() => setSource("plugins")}>{copy.sourcePlugins}</button>
      </div>
      <button className="button" onClick={() => void load()} disabled={loading}>{copy.refresh}</button>
      <button className="button" onClick={() => void copyPath()} disabled={!result.path}>{copy.copy}</button>
    </div></header>
    {error && <Toast kind="error" message={error} onClose={() => setError("")} />}

    {source === "plugins" ? (
      <section className="panel logs-toolbar">
        <label>{copy.pluginPick}
          <select value={pluginId} onChange={(event) => setPluginId(event.target.value)} disabled={!plugins.length}>
            {plugins.map((item) => <option key={item.plugin_id} value={item.plugin_id}>{item.name}（{item.plugin_id} · {formatSize(item.size_bytes)}）</option>)}
          </select>
        </label>
        <label>{copy.search}<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={copy.search} /></label>
        <label>{copy.lines}<select value={lineCount} onChange={(event) => setLineCount(Number(event.target.value))}><option value={100}>100</option><option value={300}>300</option><option value={1000}>1000</option></select></label>
        {selectedPlugin && <a className="button" href={api.pluginLogDownloadUrl(selectedPlugin.plugin_id)}>{copy.pluginDownload}</a>}
      </section>
    ) : (
      <section className="panel logs-toolbar"><label>{copy.search}<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={copy.search} /></label><label>{copy.lines}<select value={lineCount} onChange={(event) => setLineCount(Number(event.target.value))}><option value={100}>100</option><option value={300}>300</option><option value={1000}>1000</option></select></label><div className="log-levels"><button className={!level ? "active" : ""} onClick={() => setLevel("")}>{copy.all}</button>{["INFO", "WARNING", "ERROR"].map((item) => <button key={item} className={level === item ? "active" : ""} onClick={() => setLevel(item)}>{item}</button>)}</div></section>
    )}

    <section className="panel logs-panel"><header><div><h2>{source === "plugins" ? copy.pluginViewer : copy.viewer}</h2><p>{copy.loaded} {visibleLines.length}{search ? ` / ${result.lines.length}` : ""}</p></div><code title={result.path}>{copy.path}: {result.path || "—"}</code></header>
      {loading ? <p className="muted">…</p>
        : source === "plugins" && !plugins.length ? <p className="logs-empty">{copy.pluginNone}</p>
        : visibleLines.length ? <pre>{visibleLines.join("\n")}</pre> : <p className="logs-empty">{copy.empty}</p>}
    </section>
  </main>;
}
