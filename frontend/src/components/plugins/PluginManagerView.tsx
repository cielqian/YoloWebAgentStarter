import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { Toast } from "../Toast";
import type { PluginMeta } from "../../types";

export function PluginManagerView({ onChanged }: { onChanged?: () => void }) {
  const [plugins, setPlugins] = useState<PluginMeta[]>([]);
  const [dropinsDir, setDropinsDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<PluginMeta>();
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    api.listPlugins()
      .then((result) => { setPlugins(result.items); setDropinsDir(result.dropins_dir); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "加载失败"))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const install = async (file: File) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const installed = await api.installPlugin(file);
      setNotice(`已安装插件「${installed.name}」v${installed.version}`);
      refresh();
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "安装失败");
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const installed = await api.scanPluginDropins();
      setNotice(installed.length ? `已从 dropins 装载 ${installed.length} 个插件` : "dropins 目录没有新的插件包");
      refresh();
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "扫描失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (plugin: PluginMeta) => {
    setBusy(true); setError("");
    try {
      await api.deletePlugin(plugin.id);
      setDeleteTarget(undefined);
      setNotice(`已卸载插件「${plugin.name}」`);
      refresh();
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "卸载失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="plugin-manager-page">
      <header className="models-page-header">
        <div>
          <span className="eyebrow">PLUGINS</span>
          <h1>插件管理</h1>
          <p className="muted">安装 zip 插件包，或把包放入 dropins 目录由平台自动装载；插件出现在左侧「扩展」分组。</p>
        </div>
        <div className="plugin-host-actions">
          <button type="button" className="button" disabled={busy} onClick={() => void scan()}>扫描 dropins</button>
          <button type="button" className="button primary" disabled={busy} onClick={() => fileRef.current?.click()}>安装插件包</button>
          <input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void install(file);
            event.currentTarget.value = "";
          }} />
        </div>
      </header>
      {error && <Toast kind="error" message={error} onClose={() => setError("")} />}
      {notice && <Toast kind="success" message={notice} onClose={() => setNotice("")} />}
      <section className="panel settings-card">
        <div className="dropins-hint">
          <strong>自动装载目录</strong>
          <code>{dropinsDir || "…"}</code>
          <small>把符合规范的 .zip 放入该目录，服务启动时或点击「扫描 dropins」后自动解压安装；同名 id 会覆盖升级。</small>
        </div>
      </section>
      {loading ? <p className="muted">正在加载插件列表…</p> : plugins.length ? (
        <div className="models-drill-list">
          {plugins.map((plugin) => (
            <div key={plugin.id} className="plugin-row">
              <span className="plugin-row-icon">{plugin.icon ?? "🧩"}</span>
              <div className="plugin-row-main">
                <strong>{plugin.name} <em>v{plugin.version}</em></strong>
                <small>{plugin.id}{plugin.author ? ` · ${plugin.author}` : ""}{plugin.description ? ` · ${plugin.description}` : ""}</small>
              </div>
              <button type="button" className="button class-library-delete" disabled={busy} onClick={() => setDeleteTarget(plugin)}>卸载</button>
            </div>
          ))}
        </div>
      ) : <p className="muted">还没有安装任何插件。</p>}
      {deleteTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeleteTarget(undefined)}>
          <section className="dataset-dialog dataset-delete-dialog" role="alertdialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className="eyebrow">UNINSTALL</span><h2>卸载插件「{deleteTarget.name}」？</h2><p>插件文件会从平台移除，左侧扩展区菜单同步消失。</p></div><button className="icon-button" onClick={() => setDeleteTarget(undefined)} aria-label="关闭">×</button></header>
            <footer><button className="button" disabled={busy} onClick={() => setDeleteTarget(undefined)}>取消</button><button className="button danger" disabled={busy} onClick={() => void remove(deleteTarget)}>确认卸载</button></footer>
          </section>
        </div>
      )}
    </main>
  );
}
