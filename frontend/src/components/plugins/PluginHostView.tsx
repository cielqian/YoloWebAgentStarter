import { useMemo, useState } from "react";
import { apiUrl } from "../../api/client";
import type { PluginMeta } from "../../types";

/** 插件宿主:iframe 加载插件入口页,通过 __ctx 查询参数注入宿主上下文。 */
export function PluginHostView({ plugin }: { plugin: PluginMeta }) {
  const [nonce, setNonce] = useState(0);
  const src = useMemo(() => {
    const context = { apiBase: apiUrl("/api").replace(/\/api\/?$/, ""), pluginId: plugin.id };
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(context))));
    return `${apiUrl(`/api/plugins/${plugin.id}/asset/${plugin.entry}`)}?__ctx=${encodeURIComponent(encoded)}&__v=${nonce}`;
  }, [plugin.id, plugin.entry, nonce]);

  return (
    <main className="plugin-host-page">
      <header className="plugin-host-head">
        <div>
          <span className="eyebrow">PLUGIN</span>
          <h1>{plugin.icon ? `${plugin.icon} ` : ""}{plugin.name}</h1>
          {plugin.description && <p className="muted">{plugin.description}</p>}
        </div>
        <div className="plugin-host-actions">
          <span className="models-chip">v{plugin.version}</span>
          <button type="button" className="button" onClick={() => setNonce((value) => value + 1)}>刷新</button>
          <a className="button" href={src} target="_blank" rel="noreferrer">新窗口打开</a>
        </div>
      </header>
      <section className="plugin-host-frame">
        <iframe key={nonce} src={src} title={plugin.name} sandbox="allow-scripts allow-forms allow-same-origin allow-popups" />
      </section>
    </main>
  );
}
