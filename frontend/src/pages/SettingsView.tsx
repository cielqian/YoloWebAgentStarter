import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api/client";
import { Toast } from "../components/Toast";
import type { AppLocale } from "../locale";
import { saveLocale } from "../locale";
import type {
  BaseWeight,
  FtpSettings,
  LLMAuthScheme,
  LLMSettings,
  SamSettings,
  TrainingDevice,
  TrainingNode,
  TrainingNodeStatus,
  WebhookEvent,
  WebhookMethod,
  WebhookSettings,
} from "../types";

export type SettingsTab = "llm" | "sam" | "ftp" | "nodes" | "weights" | "webhook" | "language";

type LlmFormState = LLMSettings & { api_key: string };

const LLM_AUTH_SCHEMES: LLMAuthScheme[] = ["bearer", "header", "raw_authorization"];

const copy = {
  zh: {
    eyebrow: "WORKSPACE SETTINGS",
    title: "设置",
    subtitle: "管理此设备上的 Agent LLM、辅助标注与工作台偏好。配置保存在本地 data 目录，不会写入 SQLite。",
    local: "本地",
    llmNav: "Agent LLM",
    llmNavDescription: "Provider、模型与 API Key",
    samNav: "SAM 辅助",
    samNavDescription: "模型、设备与建议方式",
    languageNav: "语言",
    languageNavDescription: "工作台显示偏好",
    llmTitle: "Agent LLM",
    llmSubtitle: "对齐上游设置页：启用后使用 OpenAI 兼容接口；关闭则使用本地规则规划器。密钥只保存在 settings.json。",
    enabled: "启用 LLM Provider",
    enabledHint: "关闭时 Agent 使用本地 mock / 规则规划，不发起远端调用。",
    provider: "Provider",
    model: "模型",
    apiBase: "API Base URL",
    apiKey: "API Key",
    apiKeyKeep: "已配置密钥：留空则保留原值",
    apiKeyOptional: "可选：本地服务可不填",
    authScheme: "鉴权方式",
    authHeaderName: "自定义 Header 名",
    authHeaderHint: "仅 auth_scheme=header 时需要，例如 X-Api-Key",
    temperature: "Temperature",
    timeout: "请求超时（秒）",
    advanced: "高级",
    plannerTitle: "规划预设",
    plannerSubtitle: "仅调整 temperature，需点保存后生效。",
    cost: "省成本",
    balanced: "均衡",
    quality: "高质量",
    test: "测试连接",
    testing: "测试中…",
    save: "保存 LLM 设置",
    saved: "LLM 设置已保存",
    llmReady: "已启用",
    llmLocal: "本地规则",
    llmFooter: "测试不会落盘。空 API Key 在保存时保留已有密钥。",
    samTitle: "SAM 辅助标注",
    samSubtitle: "配置 segment 标注页使用的交互式 SAM 建议。建议结果仍需人工确认后保存。",
    samEnabled: "启用 SAM 辅助",
    samBackend: "SAM3 服务地址",
    samBackendHint: "远程 SAM3 分割服务（文本提示，如 http://10.12.42.125:7860）。填写后优先使用，留空则回退下方本地权重。",
    samLocalFallbackHint: "已配置远程 SAM3 服务：推理在远程完成，下方本地权重 / 设备 / 尺寸仅在地址留空时作为回退使用。",
    modelSam: "模型权重或模型 ID",
    modelHint: "可填写本地 .pt 路径或 Ultralytics 可识别的模型名，例如 sam_b.pt。",
    device: "推理设备",
    imageSize: "推理尺寸",
    fallback: "未配置模型时",
    box: "使用框形 review-only 建议",
    disabled: "禁用回退",
    saveSam: "保存 SAM 设置",
    savedSam: "SAM 设置已保存",
    ftpNav: "FTP 服务",
    ftpNavDescription: "主机、账号与连接偏好",
    ftpTitle: "FTP 连接",
    ftpSubtitle: "供“FTP 管理”页浏览、上传、下载与移动文件。凭据只保存在 settings.json。",
    ftpHost: "主机",
    ftpPort: "端口",
    ftpUser: "用户名",
    ftpPassword: "密码",
    ftpPasswordKeep: "已配置密码：留空则保留原值",
    ftpPassive: "被动模式 (PASV)",
    ftpPassiveHint: "多数内网/云 FTP 需要开启；仅极少数老服务器要关闭。",
    ftpEncoding: "路径编码",
    ftpEncodingHint: "中文服务器常用 gbk，默认 utf-8。",
    ftpTimeout: "连接超时（秒）",
    ftpTest: "测试连接",
    ftpTesting: "测试中…",
    saveFtp: "保存 FTP 设置",
    savedFtp: "FTP 设置已保存",
    ftpConfigured: "已配置",
    ftpNotConfigured: "未配置",
    nodesNav: "训练节点",
    nodesNavDescription: "远程算力服务器巡检",
    weightsNav: "基础权重",
    weightsNavDescription: "训练起始权重库 · 远程节点按需拉取",
    weightsTitle: "基础权重库",
    weightsSubtitle: "上传 .pt 权重后，远程训练节点本地没有时会自动向中心端拉取并缓存，后续任务不再重复下载。",
    weightsUpload: "上传权重",
    weightsEmpty: "还没有基础权重。上传 yolov8n.pt 等预置权重后，离线训练节点也能直接开训。",
    weightsDeleteConfirm: "删除基础权重「{name}」？已缓存的节点不受影响。",
    nodesTitle: "训练节点",
    nodesSubtitle: "注册部署了 compute-agent 的算力服务器（GPU / NPU）。「训练」页会展示其设备巡检结果。配置保存在 settings.json。",
    nodeName: "节点名称",
    nodeUrl: "Agent 地址",
    nodeUrlHint: "例如 http://10.12.42.125:8010，需先在服务器上启动 compute-agent。",
    nodeToken: "共享密钥",
    nodeTokenHint: "agent 启动时设置的 token；未设置则留空。仅保存，不回显。",
    nodeAdd: "添加节点",
    nodeTest: "测试连接",
    nodeTesting: "测试中…",
    nodeDelete: "删除",
    nodeConfirmDelete: "确认删除",
    nodesEmpty: "还没有注册训练节点。在算力服务器上启动 compute-agent 后，在这里添加。",
    nodesRegistered: "{count} 个节点",
    nodeAdded: "节点已添加",
    nodeDeleted: "节点已删除",
    nodeTestOk: "连接成功：{hostname} · {count} 个设备（{types}）",
    nodeTestFail: "连接失败",
    webhookNav: "Webhook 通知",
    webhookNavDescription: "训练启动 / 结束 / 异常回调",
    webhookTitle: "Webhook 通知",
    webhookSubtitle: "训练任务启动、完成、失败或停止时，向下方地址发送 HTTP 通知：POST 可自定义请求体模板，GET 携带查询参数。配置保存在 settings.json。",
    webhookEnabled: "启用 Webhook 通知",
    webhookEnabledHint: "关闭后不发送任何通知。",
    webhookUrl: "通知地址",
    webhookUrlHint: "以 http:// 或 https:// 开头，例如 https://example.com/hook。",
    webhookMethod: "请求方法",
    webhookBody: "请求体模板（仅 POST 生效，留空发送默认 JSON）",
    webhookBodyHint: "可用占位符：{title} 标题、{status} 状态、{model} 模型名、{dataset} 数据集、{duration} 训练耗时；另有 {event}、{name}、{task_id}、{error_message}、{progress_percent}。",
    webhookEvents: "通知事件",
    eventStarted: "训练启动",
    eventCompleted: "训练完成",
    eventFailed: "训练失败",
    eventStopped: "训练停止",
    webhookTest: "发送测试",
    webhookTesting: "发送中…",
    saveWebhook: "保存 Webhook 设置",
    savedWebhook: "Webhook 设置已保存",
    webhookConfigured: "已启用",
    ready: "已配置真实模型",
    fallbackReady: "使用框形建议",
    disabledStatus: "已关闭",
    samFooter: "SAM 只对 segment 数据集开放。",
    languageTitle: "语言设置",
    languageSubtitle: "切换工作台界面语言。偏好只保存在当前浏览器中。",
    displayLanguage: "显示语言",
    chinese: "简体中文",
    english: "English",
    applied: "已立即应用",
    loading: "正在读取设置…",
    error: "设置读取失败",
    availableDevices: "当前设备",
    noDevice: "没有额外 GPU，仍可手动填写设备标识。",
    cuda: "CUDA",
    mps: "Apple GPU (MPS)",
    cpu: "CPU",
    auto: "自动选择",
    show: "显示",
    hide: "隐藏",
    testMissingApiBase: "请填写 API Base URL（例如 https://api.openai.com/v1）",
    testSkippedNoKey: "未配置 API Key（可选），已跳过远端连接测试。需要调用 LLM 时再填写密钥即可。",
    testConnectError: "无法连接到服务器，请检查 API Base URL。",
    testTimeout: "请求超时，请检查网络、代理或增大 Request Timeout 后重试",
    testRequestError: "请求失败，请检查 API Base URL 和网络连接。",
    testOk: "连接成功，Chat Completions 可正常使用。",
    testHttpError: "API 返回 HTTP {status}",
  },
  en: {
    eyebrow: "WORKSPACE SETTINGS",
    title: "Settings",
    subtitle: "Manage Agent LLM, assisted annotation, and workspace preferences. Stored in the local data directory — never in SQLite.",
    local: "Local",
    llmNav: "Agent LLM",
    llmNavDescription: "Provider, model, and API key",
    samNav: "SAM assist",
    samNavDescription: "Model, device, and proposal behavior",
    languageNav: "Language",
    languageNavDescription: "Workspace display preference",
    llmTitle: "Agent LLM",
    llmSubtitle: "Upstream-aligned settings: enable OpenAI-compatible chat; disable for the local rule planner. Keys live in settings.json only.",
    enabled: "Enable LLM provider",
    enabledHint: "When off, Agent uses the local mock / rule planner and does not call a remote LLM.",
    provider: "Provider",
    model: "Model",
    apiBase: "API Base URL",
    apiKey: "API Key",
    apiKeyKeep: "Key configured — leave blank to keep it",
    apiKeyOptional: "Optional for local endpoints",
    authScheme: "Auth scheme",
    authHeaderName: "Custom header name",
    authHeaderHint: "Required when auth_scheme is header, e.g. X-Api-Key",
    temperature: "Temperature",
    timeout: "Request timeout (seconds)",
    advanced: "Advanced",
    plannerTitle: "Planner presets",
    plannerSubtitle: "Adjusts temperature only; click Save to persist.",
    cost: "Cost",
    balanced: "Balanced",
    quality: "Quality",
    test: "Test connection",
    testing: "Testing…",
    save: "Save LLM settings",
    saved: "LLM settings saved",
    llmReady: "Enabled",
    llmLocal: "Local rules",
    llmFooter: "Tests do not persist. An empty API key keeps the existing secret on save.",
    samTitle: "SAM assisted annotation",
    samSubtitle: "Configure interactive SAM proposals for segment annotation. Review every proposal before saving it.",
    samEnabled: "Enable SAM assist",
    samBackend: "SAM3 service URL",
    samBackendHint: "Remote SAM3 segmentation service (text-prompted, e.g. http://10.12.42.125:7860). Takes priority when set; leave empty to use the local weights below.",
    samLocalFallbackHint: "A remote SAM3 service is configured: inference runs remotely. The local weights / device / size below only apply as fallback when the URL is empty.",
    modelSam: "Model checkpoint or model id",
    modelHint: "Use a local .pt path or an Ultralytics model name such as sam_b.pt.",
    device: "Inference device",
    imageSize: "Inference size",
    fallback: "When no model is configured",
    box: "Use box-shaped review-only proposals",
    disabled: "Disable fallback",
    saveSam: "Save SAM settings",
    savedSam: "SAM settings saved",
    ftpNav: "FTP Service",
    ftpNavDescription: "Host, credentials and connection",
    ftpTitle: "FTP Connection",
    ftpSubtitle: "Used by the FTP manager page to browse, upload, download and move files. Credentials stay in settings.json.",
    ftpHost: "Host",
    ftpPort: "Port",
    ftpUser: "Username",
    ftpPassword: "Password",
    ftpPasswordKeep: "Password configured: leave empty to keep it",
    ftpPassive: "Passive mode (PASV)",
    ftpPassiveHint: "Most cloud / intranet servers need PASV on.",
    ftpEncoding: "Path encoding",
    ftpEncodingHint: "Use gbk for many Chinese servers; default utf-8.",
    ftpTimeout: "Connection timeout (s)",
    ftpTest: "Test connection",
    ftpTesting: "Testing…",
    saveFtp: "Save FTP settings",
    savedFtp: "FTP settings saved",
    ftpConfigured: "Configured",
    ftpNotConfigured: "Not configured",
    nodesNav: "Training nodes",
    nodesNavDescription: "Remote compute servers",
    weightsNav: "Base weights",
    weightsNavDescription: "Training starter weights",
    weightsTitle: "Base weight library",
    weightsSubtitle: "Upload .pt weights; remote agents pull them on demand and cache locally.",
    weightsUpload: "Upload weight",
    weightsEmpty: "No base weights yet. Upload yolov8n.pt etc. so offline agents can train directly.",
    weightsDeleteConfirm: "Delete base weight {name}? Cached agents are not affected.",
    nodesTitle: "Training nodes",
    nodesSubtitle: "Register servers running compute-agent (GPU / NPU). Their devices show up on the Training page. Stored in settings.json.",
    nodeName: "Node name",
    nodeUrl: "Agent URL",
    nodeUrlHint: "e.g. http://10.12.42.125:8010 — start compute-agent on the server first.",
    nodeToken: "Shared token",
    nodeTokenHint: "The token the agent was started with; leave empty if none. Stored, never echoed.",
    nodeAdd: "Add node",
    nodeTest: "Test connection",
    nodeTesting: "Testing…",
    nodeDelete: "Delete",
    nodeConfirmDelete: "Confirm delete",
    nodesEmpty: "No training nodes yet. Start compute-agent on a server and add it here.",
    nodesRegistered: "{count} nodes",
    nodeAdded: "Node added",
    nodeDeleted: "Node deleted",
    nodeTestOk: "Connected: {hostname} · {count} devices ({types})",
    nodeTestFail: "Connection failed",
    webhookNav: "Webhook",
    webhookNavDescription: "Training lifecycle callbacks",
    webhookTitle: "Webhook notifications",
    webhookSubtitle: "Send an HTTP notification when a training task starts, completes, fails, or stops: POST carries a JSON task body, GET carries query parameters. Stored in settings.json.",
    webhookEnabled: "Enable webhook notifications",
    webhookEnabledHint: "No notifications are sent while disabled.",
    webhookUrl: "Notification URL",
    webhookUrlHint: "Must start with http:// or https://, e.g. https://example.com/hook.",
    webhookMethod: "HTTP method",
    webhookBody: "Body template (POST only; empty sends default JSON)",
    webhookBodyHint: "Placeholders: {title}, {status}, {model}, {dataset}, {duration}; also {event}, {name}, {task_id}, {error_message}, {progress_percent}.",
    webhookEvents: "Events",
    eventStarted: "Training started",
    eventCompleted: "Training completed",
    eventFailed: "Training failed",
    eventStopped: "Training stopped",
    webhookTest: "Send test",
    webhookTesting: "Sending…",
    saveWebhook: "Save webhook settings",
    savedWebhook: "Webhook settings saved",
    webhookConfigured: "Enabled",
    ready: "Real model configured",
    fallbackReady: "Box proposals",
    disabledStatus: "Disabled",
    samFooter: "SAM assist is available for segment datasets only.",
    languageTitle: "Language settings",
    languageSubtitle: "Switch the workspace language. The preference is stored in this browser only.",
    displayLanguage: "Display language",
    chinese: "简体中文",
    english: "English",
    applied: "Applied immediately",
    loading: "Loading settings…",
    error: "Could not load settings",
    availableDevices: "Available devices",
    noDevice: "No extra GPU was detected; you can still enter a device id manually.",
    cuda: "CUDA",
    mps: "Apple GPU (MPS)",
    cpu: "CPU",
    auto: "Auto",
    show: "Show",
    hide: "Hide",
    testMissingApiBase: "Enter an API Base URL (for example https://api.openai.com/v1).",
    testSkippedNoKey: "No API key configured (optional). Remote probe skipped; add a key before calling the LLM.",
    testConnectError: "Could not reach the server. Check the API Base URL.",
    testTimeout: "Request timed out. Check network/proxy or increase Request Timeout.",
    testRequestError: "Request failed. Check the API Base URL and network.",
    testOk: "Connection succeeded. Chat Completions is usable.",
    testHttpError: "API returned HTTP {status}",
  },
} as const;

type SettingsText = (typeof copy)[AppLocale];

function localizeLlmTestMessage(
  text: SettingsText,
  result: { message: string; code?: string; http_status?: number | null },
): string {
  switch (result.code) {
    case "missing_api_base":
      return text.testMissingApiBase;
    case "skipped_no_key":
      return text.testSkippedNoKey;
    case "connect_error":
      return text.testConnectError;
    case "timeout":
      return text.testTimeout;
    case "request_error":
      return text.testRequestError;
    case "ok":
      return text.testOk;
    case "http_error":
      return text.testHttpError.replace("{status}", String(result.http_status ?? ""));
    default:
      return result.message;
  }
}

function emptyLlmForm(): LlmFormState {
  return {
    enabled: false,
    provider: "openai-compatible",
    api_base: "",
    model: "gpt-4o-mini",
    temperature: 0.2,
    timeout_seconds: 60,
    api_key_configured: false,
    auth_scheme: "bearer",
    auth_header_name: "",
    api_key: "",
  };
}

export function SettingsView({
  tab,
  locale,
  onLocaleChange,
  onSamSettingsChange,
  onTabChange,
}: {
  tab: SettingsTab;
  locale: AppLocale;
  onLocaleChange: (locale: AppLocale) => void;
  onSamSettingsChange?: () => void;
  onTabChange: (tab: SettingsTab) => void;
}) {
  const text = copy[locale];
  return (
    <main className="settings-layout">
      <header className="settings-page-head">
        <div>
          <span className="eyebrow">{text.eyebrow}</span>
          <h1>{text.title}</h1>
          <p>{text.subtitle}</p>
        </div>
        <span className="settings-page-badge">{text.local}</span>
      </header>
      <div className="settings-section-layout">
        <nav className="settings-section-nav" aria-label={text.title}>
          <SettingsNavigationItem
            active={tab === "llm"}
            icon={<LlmIcon />}
            title={text.llmNav}
            description={text.llmNavDescription}
            onClick={() => onTabChange("llm")}
          />
          <SettingsNavigationItem
            active={tab === "sam"}
            icon={<SamIcon />}
            title={text.samNav}
            description={text.samNavDescription}
            onClick={() => onTabChange("sam")}
          />
          <SettingsNavigationItem
            active={tab === "ftp"}
            icon={<FtpIcon />}
            title={text.ftpNav}
            description={text.ftpNavDescription}
            onClick={() => onTabChange("ftp")}
          />
          <SettingsNavigationItem
            active={tab === "nodes"}
            icon={<NodeIcon />}
            title={text.nodesNav}
            description={text.nodesNavDescription}
            onClick={() => onTabChange("nodes")}
          />
          <SettingsNavigationItem
            active={tab === "weights"}
            icon={<NodeIcon />}
            title={text.weightsNav}
            description={text.weightsNavDescription}
            onClick={() => onTabChange("weights")}
          />
          <SettingsNavigationItem
            active={tab === "webhook"}
            icon={<WebhookIcon />}
            title={text.webhookNav}
            description={text.webhookNavDescription}
            onClick={() => onTabChange("webhook")}
          />
          <SettingsNavigationItem
            active={tab === "language"}
            icon={<LanguageIcon />}
            title={text.languageNav}
            description={text.languageNavDescription}
            onClick={() => onTabChange("language")}
          />
        </nav>
        <div className="settings-section-content">
          {tab === "llm" ? (
            <LlmSettingsPanel locale={locale} text={text} />
          ) : tab === "sam" ? (
            <SamSettingsPanel locale={locale} text={text} onSamSettingsChange={onSamSettingsChange} />
          ) : tab === "ftp" ? (
            <FtpSettingsPanel text={text} />
          ) : tab === "nodes" ? (
            <TrainingNodesPanel text={text} />
          ) : tab === "weights" ? (
            <BaseWeightsPanel text={text} />
          ) : tab === "webhook" ? (
            <WebhookSettingsPanel text={text} />
          ) : (
            <LanguageSettingsPanel locale={locale} text={text} onLocaleChange={onLocaleChange} />
          )}
        </div>
      </div>
    </main>
  );
}

function SettingsNavigationItem({
  active,
  icon,
  title,
  description,
  badge,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`settings-section-nav-item ${active ? "active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <span className="settings-nav-icon">{icon}</span>
      <span className="settings-section-nav-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      {badge ? <span className="settings-nav-badge">{badge}</span> : null}
    </button>
  );
}

function LlmSettingsPanel({ text }: { locale: AppLocale; text: SettingsText }) {
  const [form, setForm] = useState<LlmFormState>(emptyLlmForm);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [preset, setPreset] = useState<"cost" | "balanced" | "quality">("balanced");

  useEffect(() => {
    void api
      .getLlmSettings()
      .then((settings) => setForm({ ...settings, api_key: "" }))
      .catch((reason) => setError(reason instanceof Error ? reason.message : text.error))
      .finally(() => setBusy(false));
  }, [text.error]);

  const status = form.enabled ? text.llmReady : text.llmLocal;

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const saved = await api.updateLlmSettings({
        enabled: form.enabled,
        provider: form.provider,
        api_base: form.api_base,
        api_key: form.api_key,
        model: form.model,
        temperature: form.temperature,
        timeout_seconds: form.timeout_seconds,
        auth_scheme: form.auth_scheme,
        auth_header_name: form.auth_scheme === "header" ? form.auth_header_name : "",
      });
      setForm({ ...saved, api_key: "" });
      setMessage(text.saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text.error);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setError("");
    setMessage("");
    try {
      const result = await api.testLlmConnection({
        api_base: form.api_base,
        model: form.model,
        api_key: form.api_key,
        timeout_seconds: form.timeout_seconds,
        auth_scheme: form.auth_scheme,
        auth_header_name: form.auth_scheme === "header" ? form.auth_header_name : "",
      });
      const localized = localizeLlmTestMessage(text, result);
      setMessage(localized);
      if (!result.ok) setError(localized);
      else setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text.error);
    } finally {
      setTesting(false);
    }
  };

  const applyPreset = (next: "cost" | "balanced" | "quality") => {
    setPreset(next);
    const temperature = next === "cost" ? 0.1 : next === "quality" ? 0.9 : 0.4;
    setForm((current) => ({ ...current, temperature }));
  };

  if (busy) return <section className="panel settings-card"><p className="muted settings-loading">{text.loading}</p></section>;

  return (
    <form className="panel settings-card" onSubmit={(event) => void save(event)}>
      <header className="settings-card-head">
        <div className="settings-card-icon"><LlmIcon /></div>
        <div>
          <h2>{text.llmTitle}</h2>
          <p>{text.llmSubtitle}</p>
        </div>
        <span className={`settings-status ${form.enabled ? "ready" : "disabled"}`}>{status}</span>
      </header>
      {error ? <Toast kind="error" message={error} onClose={() => setError("")} /> : null}
      {message && !error ? <Toast kind="success" message={message} onClose={() => setMessage("")} /> : null}

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
        />
        <span>
          <strong>{text.enabled}</strong>
          <small>{text.enabledHint}</small>
        </span>
      </label>

      <div className="settings-form-grid">
        <label>
          <span>{text.provider}</span>
          <select value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value })}>
            <option value="openai-compatible">openai-compatible</option>
            <option value="openai">openai</option>
            <option value="local">local</option>
          </select>
        </label>
        <label>
          <span>{text.model}</span>
          <input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} />
        </label>
        <label className="settings-span-2">
          <span>{text.apiBase}</span>
          <input
            value={form.api_base}
            placeholder="https://api.openai.com/v1"
            onChange={(event) => setForm({ ...form, api_base: event.target.value })}
          />
        </label>
        <label className="settings-span-2">
          <span>{text.apiKey}</span>
          <div className="settings-key-line">
            <input
              type={showKey ? "text" : "password"}
              value={form.api_key}
              placeholder={form.api_key_configured ? text.apiKeyKeep : text.apiKeyOptional}
              onChange={(event) => setForm({ ...form, api_key: event.target.value })}
              autoComplete="off"
            />
            <button type="button" className="button" onClick={() => setShowKey((value) => !value)}>
              {showKey ? text.hide : text.show}
            </button>
          </div>
        </label>
        <label>
          <span>{text.authScheme}</span>
          <select
            value={form.auth_scheme}
            onChange={(event) => {
              const auth_scheme = event.target.value as LLMAuthScheme;
              setForm({
                ...form,
                auth_scheme,
                auth_header_name: auth_scheme === "header" ? form.auth_header_name : "",
              });
            }}
          >
            {LLM_AUTH_SCHEMES.map((scheme) => (
              <option key={scheme} value={scheme}>{scheme}</option>
            ))}
          </select>
        </label>
        {form.auth_scheme === "header" ? (
          <label>
            <span>{text.authHeaderName}</span>
            <input
              value={form.auth_header_name}
              placeholder="X-Api-Key"
              onChange={(event) => setForm({ ...form, auth_header_name: event.target.value })}
            />
            <small>{text.authHeaderHint}</small>
          </label>
        ) : (
          <div />
        )}
      </div>

      <div className="settings-advanced-title">{text.advanced}</div>
      <div className="settings-form-grid">
        <label>
          <span>{text.temperature} · {form.temperature.toFixed(1)}</span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={form.temperature}
            onChange={(event) => setForm({ ...form, temperature: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>{text.timeout}</span>
          <input
            type="number"
            min={1}
            max={7200}
            value={form.timeout_seconds}
            onChange={(event) => {
              const n = Number(event.target.value);
              setForm({
                ...form,
                timeout_seconds: Number.isFinite(n) ? Math.min(7200, Math.max(1, Math.round(n))) : form.timeout_seconds,
              });
            }}
          />
        </label>
      </div>

      <section className="settings-planner-card">
        <strong>{text.plannerTitle}</strong>
        <p>{text.plannerSubtitle}</p>
        <div className="settings-preset-row">
          {(["cost", "balanced", "quality"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`button ${preset === item ? "primary" : ""}`}
              onClick={() => applyPreset(item)}
            >
              {text[item]}
            </button>
          ))}
        </div>
      </section>

      <footer className="settings-footer">
        <span>{text.llmFooter}</span>
        <div className="settings-footer-actions">
          <button type="button" className="button" disabled={testing || saving} onClick={() => void test()}>
            {testing ? text.testing : text.test}
          </button>
          <button type="submit" className="button primary" disabled={saving || testing}>
            {saving ? "…" : text.save}
          </button>
        </div>
      </footer>
    </form>
  );
}

function SamSettingsPanel({ locale, text, onSamSettingsChange }: { locale: AppLocale; text: SettingsText; onSamSettingsChange?: () => void }) {
  const [settings, setSettings] = useState<SamSettings>();
  const [devices, setDevices] = useState<TrainingDevice[]>([]);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([api.getSamSettings(), api.listTrainingDevices()])
      .then(([nextSettings, nextDevices]) => {
        setSettings(nextSettings);
        setDevices(nextDevices.items);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : text.error))
      .finally(() => setBusy(false));
  }, [text.error]);

  const deviceOptions = useMemo(
    () => [
      { value: "auto", label: text.auto },
      { value: "cpu", label: text.cpu },
      ...devices.filter((device) => device.type === "mps").map(() => ({ value: "mps", label: text.mps })),
      ...(devices.some((device) => device.type === "cuda") ? [{ value: "cuda", label: text.cuda }] : []),
      ...devices
        .filter((device) => device.type === "cuda")
        .map((device) => ({ value: String(device.index ?? 0), label: `${text.cuda}:${device.index ?? 0} · ${device.name}` })),
    ],
    [devices, text],
  );

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      setSettings(
        await api.updateSamSettings({
          enabled: settings.enabled,
          backend: settings.backend,
          model: settings.model,
          device: settings.device,
          img_size: settings.img_size,
          fallback_mode: settings.fallback_mode,
        }),
      );
      onSamSettingsChange?.();
      setMessage(text.savedSam);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text.error);
    } finally {
      setSaving(false);
    }
  };

  if (busy) return <section className="panel settings-card"><p className="muted settings-loading">{text.loading}</p></section>;
  if (!settings) return <section className="panel settings-card"><div className="validation invalid">{error || text.error}</div></section>;
  const status = settings.enabled ? (settings.model_configured ? text.ready : text.fallbackReady) : text.disabledStatus;
  return (
    <section className="panel settings-card">
      <header className="settings-card-head">
        <div className="settings-card-icon"><SamIcon /></div>
        <div>
          <h2>{text.samTitle}</h2>
          <p>{text.samSubtitle}</p>
        </div>
        <span className={`settings-status ${settings.enabled ? "ready" : "disabled"}`}>{status}</span>
      </header>
      {error ? <Toast kind="error" message={error} onClose={() => setError("")} /> : null}
      {message ? <Toast kind="success" message={message} onClose={() => setMessage("")} /> : null}
      <div className="settings-form-grid">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
          />
          <span>
            <strong>{text.samEnabled}</strong>
            <small>{settings.backend || (settings.model_configured ? settings.model : text.modelHint)}</small>
          </span>
        </label>
        <label>
          <span>{text.samBackend}</span>
          <input
            value={settings.backend}
            placeholder="http://10.12.42.125:7860"
            onChange={(event) => setSettings({ ...settings, backend: event.target.value })}
          />
          <small>{text.samBackendHint}</small>
        </label>
        <label>
          <span>{text.modelSam}</span>
          <input value={settings.model} placeholder="sam_b.pt" onChange={(event) => setSettings({ ...settings, model: event.target.value })} />
          <small>{text.modelHint}</small>
        </label>
        <label>
          <span>{text.device}</span>
          <select value={settings.device} onChange={(event) => setSettings({ ...settings, device: event.target.value })}>
            {!deviceOptions.some((option) => option.value === settings.device) ? (
              <option value={settings.device}>{settings.device}</option>
            ) : null}
            {deviceOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{text.imageSize}</span>
          <input
            type="number"
            min={64}
            max={4096}
            step={64}
            value={settings.img_size}
            onChange={(event) => setSettings({ ...settings, img_size: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>{text.fallback}</span>
          <select
            value={settings.fallback_mode}
            onChange={(event) => setSettings({ ...settings, fallback_mode: event.target.value as SamSettings["fallback_mode"] })}
          >
            <option value="box">{text.box}</option>
            <option value="disabled">{text.disabled}</option>
          </select>
        </label>
      </div>
      {settings.backend ? <p className="settings-hint">{text.samLocalFallbackHint}</p> : null}
      {!devices.some((device) => device.type !== "cpu") ? <p className="settings-hint">{text.noDevice}</p> : null}
      <footer className="settings-footer">
        <span>{text.samFooter}</span>
        <button className="button primary" disabled={saving} onClick={() => void save()}>
          {saving ? "…" : text.saveSam}
        </button>
      </footer>
    </section>
  );
}

type FtpFormState = Omit<FtpSettings, "password_configured"> & { password: string };

const emptyFtpForm: FtpFormState = { host: "", port: 21, username: "", password: "", passive: true, encoding: "utf-8", timeout_seconds: 15 };

const FTP_ENCODINGS = ["utf-8", "gbk", "gb2312", "big5", "latin-1"];

function FtpSettingsPanel({ text }: { text: SettingsText }) {
  const [form, setForm] = useState<FtpFormState>(emptyFtpForm);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [passwordConfigured, setPasswordConfigured] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void api
      .getFtpSettings()
      .then((settings) => {
        setPasswordConfigured(settings.password_configured);
        setForm({ ...settings, password: "" });
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : text.error))
      .finally(() => setBusy(false));
  }, [text.error]);

  const persist = () => api.updateFtpSettings(form.password ? form : { ...form, password: undefined });

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const saved = await persist();
      setPasswordConfigured(saved.password_configured);
      setForm((current) => ({ ...current, password: "" }));
      setMessage(text.savedFtp);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text.error);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setError("");
    setMessage("");
    try {
      const saved = await persist();
      setPasswordConfigured(saved.password_configured);
      setForm((current) => ({ ...current, password: "" }));
      const result = await api.testFtpConnection();
      if (result.ok) setMessage(result.message);
      else setError(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text.error);
    } finally {
      setTesting(false);
    }
  };

  if (busy) return <section className="panel settings-card"><p className="muted settings-loading">{text.loading}</p></section>;
  return (
    <form className="panel settings-card" onSubmit={(event) => void save(event)}>
      <header className="settings-card-head">
        <div className="settings-card-icon"><FtpIcon /></div>
        <div>
          <h2>{text.ftpTitle}</h2>
          <p>{text.ftpSubtitle}</p>
        </div>
        <span className={`settings-status ${form.host ? "ready" : "disabled"}`}>
          {form.host ? text.ftpConfigured : text.ftpNotConfigured}
        </span>
      </header>
      {error ? <Toast kind="error" message={error} onClose={() => setError("")} /> : null}
      {message ? <Toast kind="success" message={message} onClose={() => setMessage("")} /> : null}
      <div className="settings-form-grid">
        <label>
          <span>{text.ftpHost}</span>
          <input value={form.host} placeholder="ftp.example.com" onChange={(event) => setForm({ ...form, host: event.target.value })} />
        </label>
        <label>
          <span>{text.ftpPort}</span>
          <input type="number" min={1} max={65535} value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} />
        </label>
        <label>
          <span>{text.ftpUser}</span>
          <input value={form.username} placeholder="anonymous" onChange={(event) => setForm({ ...form, username: event.target.value })} />
        </label>
        <label>
          <span>{text.ftpPassword}</span>
          <input type="password" value={form.password} placeholder={passwordConfigured ? "••••••••" : ""} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          <small>{passwordConfigured ? text.ftpPasswordKeep : ""}</small>
        </label>
        <label>
          <span>{text.ftpEncoding}</span>
          <select value={form.encoding} onChange={(event) => setForm({ ...form, encoding: event.target.value })}>
            {!FTP_ENCODINGS.includes(form.encoding) ? <option value={form.encoding}>{form.encoding}</option> : null}
            {FTP_ENCODINGS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <small>{text.ftpEncodingHint}</small>
        </label>
        <label>
          <span>{text.ftpTimeout}</span>
          <input type="number" min={3} max={120} value={form.timeout_seconds} onChange={(event) => setForm({ ...form, timeout_seconds: Number(event.target.value) })} />
        </label>
        <label className="settings-toggle">
          <input type="checkbox" checked={form.passive} onChange={(event) => setForm({ ...form, passive: event.target.checked })} />
          <span>
            <strong>{text.ftpPassive}</strong>
            <small>{text.ftpPassiveHint}</small>
          </span>
        </label>
      </div>
      <footer className="settings-footer">
        <button type="button" className="button" disabled={testing || saving || !form.host} onClick={() => void test()}>
          {testing ? text.ftpTesting : text.ftpTest}
        </button>
        <button className="button primary" disabled={saving}>{saving ? "…" : text.saveFtp}</button>
      </footer>
    </form>
  );
}

type NodeFormState = { name: string; url: string; token: string };


function BaseWeightsPanel({ text }: { text: SettingsText }) {
  const [weights, setWeights] = useState<BaseWeight[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    api.listWeights().then((result) => setWeights(result.items)).catch((reason) => setError(reason instanceof Error ? reason.message : "读取基础权重失败。"));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const upload = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setBusy(true); setError(""); setMessage("");
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (let index = 0; index < list.length; index += 1) {
      const file = list[index];
      setBusy(true);
      setMessage(list.length > 1 ? `正在上传 ${index + 1}/${list.length}：${file.name}` : "");
      try {
        await api.uploadWeight(file);
        succeeded.push(file.name);
      } catch (reason) {
        failed.push(`${file.name}（${reason instanceof Error ? reason.message : "上传失败"}）`);
      }
    }
    const summary = [
      succeeded.length ? `已上传 ${succeeded.length} 个权重` : "",
      failed.length ? `失败 ${failed.length} 个：${failed.join("、")}` : "",
    ].filter(Boolean).join("；");
    if (failed.length && !succeeded.length) setError(summary);
    else setMessage(summary);
    refresh();
    setBusy(false);
    if (fileInput.current) fileInput.current.value = "";
  };

  const remove = async (name: string) => {
    if (!window.confirm(text.weightsDeleteConfirm.replace("{name}", name))) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await api.deleteWeight(name);
      setMessage(`已删除 ${name}`);
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败。");
    } finally { setBusy(false); }
  };

  return (
    <section className="panel settings-card">
      <header className="settings-card-head">
        <div className="settings-card-icon"><NodeIcon /></div>
        <div>
          <h2>{text.weightsTitle}</h2>
          <p>{text.weightsSubtitle}</p>
        </div>
        <span className="settings-status ready">{weights.length} 个</span>
      </header>
      {error ? <Toast kind="error" message={error} onClose={() => setError("")} /> : null}
      {message && !error ? <Toast kind="success" message={message} onClose={() => setMessage("")} /> : null}

      <div className="settings-form-grid">
        <input ref={fileInput} type="file" accept=".pt" multiple hidden onChange={(event) => { void upload(event.target.files); }} />
        <label className="settings-span-2">
          <span>{text.weightsUpload}</span>
          <button type="button" className="button primary" disabled={busy} onClick={() => fileInput.current?.click()}>选择 .pt 文件上传（可多选）</button>
        </label>
        {weights.map((weight) => (
          <div key={weight.name} className="settings-weight-row">
            <strong title={weight.name}>{weight.name}</strong>
            <small>{Math.max(1, Math.round(weight.size_bytes / 1024))} KB · {formatWeightTime(weight.updated_at)}</small>
            <button type="button" className="button" disabled={busy} onClick={() => void remove(weight.name)}>删除</button>
          </div>
        ))}
        {!weights.length && <p className="muted settings-span-2">{text.weightsEmpty}</p>}
      </div>
    </section>
  );
}

function formatWeightTime(value: string): string {
  return value ? value.slice(0, 19).replace("T", " ") : "—";
}

function TrainingNodesPanel({ text }: { text: SettingsText }) {
  const [form, setForm] = useState<NodeFormState>({ name: "", url: "", token: "" });
  const [nodes, setNodes] = useState<TrainingNode[]>([]);
  const [statuses, setStatuses] = useState<Record<string, TrainingNodeStatus>>({});
  const [busy, setBusy] = useState(true);
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const reload = async () => {
    try {
      const [list, devices] = await Promise.all([api.listTrainingNodes(), api.listTrainingDevices()]);
      setNodes(list);
      setStatuses(Object.fromEntries((devices.nodes ?? []).map((node) => [node.id, node])));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text.error);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!form.name.trim() || !form.url.trim()) return;
    setAdding(true);
    setError("");
    setMessage("");
    try {
      await api.createTrainingNode(form.name.trim(), form.url.trim(), form.token.trim());
      setForm({ name: "", url: "", token: "" });
      setMessage(text.nodeAdded);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text.error);
    } finally {
      setAdding(false);
    }
  };

  const test = async () => {
    if (!form.url.trim()) return;
    setTesting(true);
    setError("");
    setMessage("");
    try {
      const result = await api.testTrainingNode(form.url.trim(), form.token.trim());
      if (result.ok) {
        setMessage(text.nodeTestOk.replace("{hostname}", result.hostname ?? "-").replace("{count}", String(result.device_count)).replace("{types}", result.device_types.join(", ")));
      } else {
        setError(`${text.nodeTestFail}：${result.message}`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text.error);
    } finally {
      setTesting(false);
    }
  };

  const remove = async (nodeId: string) => {
    setError("");
    setMessage("");
    try {
      await api.deleteTrainingNode(nodeId);
      setConfirmDeleteId(undefined);
      setMessage(text.nodeDeleted);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text.error);
    }
  };

  if (busy) return <section className="panel settings-card"><p className="muted settings-loading">{text.loading}</p></section>;
  return (
    <section className="panel settings-card">
      <header className="settings-card-head">
        <div className="settings-card-icon"><NodeIcon /></div>
        <div>
          <h2>{text.nodesTitle}</h2>
          <p>{text.nodesSubtitle}</p>
        </div>
        <span className={`settings-status ${nodes.length ? "ready" : "disabled"}`}>
          {nodes.length ? text.nodesRegistered.replace("{count}", String(nodes.length)) : text.ftpNotConfigured}
        </span>
      </header>
      {error ? <Toast kind="error" message={error} onClose={() => setError("")} /> : null}
      {message ? <Toast kind="success" message={message} onClose={() => setMessage("")} /> : null}
      {nodes.length ? (
        <div className="training-node-list">
          {nodes.map((node) => {
            const status = statuses[node.id];
            return (
              <div key={node.id} className="training-node-row">
                <div className="training-node-meta">
                  <strong>{node.name}</strong>
                  <small>{node.url}{node.token_configured ? " · 🔑" : ""}</small>
                  {status ? (
                    <small>{status.status === "online" ? `在线 · ${status.device_count} 个设备` : `不可达：${status.error ?? ""}`}</small>
                  ) : null}
                </div>
                <span className={`status ${status?.status === "online" ? "ready" : "disabled"}`}>
                  {status?.status === "online" ? "在线" : "离线"}
                </span>
                {confirmDeleteId === node.id ? (
                  <button type="button" className="button danger" onClick={() => void remove(node.id)}>{text.nodeConfirmDelete}</button>
                ) : (
                  <button type="button" className="button" onClick={() => setConfirmDeleteId(node.id)}>{text.nodeDelete}</button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted">{text.nodesEmpty}</p>
      )}
      <form className="training-node-form" onSubmit={(event) => void add(event)}>
        <label>
          <span>{text.nodeName}</span>
          <input value={form.name} placeholder="gpu-server-01" onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </label>
        <label>
          <span>{text.nodeUrl}</span>
          <input value={form.url} placeholder="http://10.12.42.125:8010" onChange={(event) => setForm({ ...form, url: event.target.value })} />
          <small>{text.nodeUrlHint}</small>
        </label>
        <label>
          <span>{text.nodeToken}</span>
          <input type="password" value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value })} />
          <small>{text.nodeTokenHint}</small>
        </label>
        <div className="training-node-form-actions">
          <button type="button" className="button" disabled={testing || !form.url.trim()} onClick={() => void test()}>{testing ? text.nodeTesting : text.nodeTest}</button>
          <button type="submit" className="button primary" disabled={adding || !form.name.trim() || !form.url.trim()}>{text.nodeAdd}</button>
        </div>
      </form>
    </section>
  );
}

const WEBHOOK_METHODS: WebhookMethod[] = ["POST", "GET"];
const WEBHOOK_EVENT_ITEMS: WebhookEvent[] = ["started", "completed", "failed", "stopped"];

function webhookEventLabel(text: SettingsText, event: WebhookEvent): string {
  switch (event) {
    case "started": return text.eventStarted;
    case "completed": return text.eventCompleted;
    case "failed": return text.eventFailed;
    case "stopped": return text.eventStopped;
  }
}

function WebhookSettingsPanel({ text }: { text: SettingsText }) {
  const [form, setForm] = useState<WebhookSettings>({
    enabled: false,
    url: "",
    method: "POST",
    events: [...WEBHOOK_EVENT_ITEMS],
    body_template: "",
  });
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void api
      .getWebhookSettings()
      .then((settings) => setForm(settings))
      .catch((reason) => setError(reason instanceof Error ? reason.message : text.error))
      .finally(() => setBusy(false));
  }, [text.error]);

  const toggleEvent = (event: WebhookEvent, checked: boolean) => {
    setForm((current) => ({
      ...current,
      events: checked
        ? WEBHOOK_EVENT_ITEMS.filter((item) => item === event || current.events.includes(item))
        : current.events.filter((item) => item !== event),
    }));
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const saved = await api.updateWebhookSettings(form);
      setForm(saved);
      setMessage(text.savedWebhook);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text.error);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setError("");
    setMessage("");
    try {
      const saved = await api.updateWebhookSettings(form);
      setForm(saved);
      const result = await api.testWebhook();
      if (result.ok) setMessage(result.message);
      else setError(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text.error);
    } finally {
      setTesting(false);
    }
  };

  if (busy) return <section className="panel settings-card"><p className="muted settings-loading">{text.loading}</p></section>;

  return (
    <form className="panel settings-card" onSubmit={(event) => void save(event)}>
      <header className="settings-card-head">
        <div className="settings-card-icon"><WebhookIcon /></div>
        <div>
          <h2>{text.webhookTitle}</h2>
          <p>{text.webhookSubtitle}</p>
        </div>
        <span className={`settings-status ${form.enabled && form.url ? "ready" : "disabled"}`}>
          {form.enabled && form.url ? text.webhookConfigured : text.ftpNotConfigured}
        </span>
      </header>
      {error ? <Toast kind="error" message={error} onClose={() => setError("")} /> : null}
      {message && !error ? <Toast kind="success" message={message} onClose={() => setMessage("")} /> : null}

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
        />
        <span>
          <strong>{text.webhookEnabled}</strong>
          <small>{text.webhookEnabledHint}</small>
        </span>
      </label>

      <div className="settings-form-grid">
        <label className="settings-span-2">
          <span>{text.webhookUrl}</span>
          <input
            value={form.url}
            placeholder="https://example.com/hook"
            onChange={(event) => setForm({ ...form, url: event.target.value })}
          />
          <small>{text.webhookUrlHint}</small>
        </label>
        <label>
          <span>{text.webhookMethod}</span>
          <select value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value as WebhookMethod })}>
            {WEBHOOK_METHODS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="settings-span-2">
          <span>{text.webhookBody}</span>
          <textarea
            className="settings-textarea"
            rows={4}
            value={form.body_template}
            placeholder={'{"msgtype":"text","text":{"content":"{title}\n状态：{status}\n模型：{model}\n数据集：{dataset}\n耗时：{duration}"}}'}
            onChange={(event) => setForm({ ...form, body_template: event.target.value })}
          />
          <small>{text.webhookBodyHint}</small>
        </label>
        {WEBHOOK_EVENT_ITEMS.map((event) => (
          <label key={event} className="settings-toggle">
            <input
              type="checkbox"
              checked={form.events.includes(event)}
              onChange={(input) => toggleEvent(event, input.target.checked)}
            />
            <span><strong>{webhookEventLabel(text, event)}</strong></span>
          </label>
        ))}
      </div>

      <footer className="settings-footer">
        <button type="button" className="button" disabled={testing || saving || !form.url.trim()} onClick={() => void test()}>
          {testing ? text.webhookTesting : text.webhookTest}
        </button>
        <button className="button primary" disabled={saving}>{saving ? "…" : text.saveWebhook}</button>
      </footer>
    </form>
  );
}

function LanguageSettingsPanel({
  locale,
  text,
  onLocaleChange,
}: {
  locale: AppLocale;
  text: SettingsText;
  onLocaleChange: (locale: AppLocale) => void;
}) {
  const change = (next: AppLocale) => {
    saveLocale(next);
    onLocaleChange(next);
  };
  return (
    <section className="panel settings-card language-card">
      <header className="settings-card-head">
        <div className="settings-card-icon"><LanguageIcon /></div>
        <div>
          <h2>{text.languageTitle}</h2>
          <p>{text.languageSubtitle}</p>
        </div>
        <span className="settings-status ready">{text.applied}</span>
      </header>
      <div className="language-card-body">
        <strong>{text.displayLanguage}</strong>
        <div className="language-segment" role="group" aria-label={text.displayLanguage}>
          <button type="button" className={locale === "zh" ? "active" : ""} onClick={() => change("zh")}>{text.chinese}</button>
          <button type="button" className={locale === "en" ? "active" : ""} onClick={() => change("en")}>{text.english}</button>
        </div>
      </div>
      <footer className="settings-footer"><span>{text.applied}</span></footer>
    </section>
  );
}

function NodeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5h16v6H4zM4 13h16v6H4zM7.5 8h.01M7.5 16h.01" />
    </svg>
  );
}

function WebhookIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4a5 5 0 0 0-5 5v3l-1.6 3.2h13.2L17 12V9a5 5 0 0 0-5-5Z" />
      <path d="M9.8 18.5a2.3 2.3 0 0 0 4.4 0" />
    </svg>
  );
}

function LlmIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16v10H4zM8 11h8M8 14h5" />
    </svg>
  );
}

function SamIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5.5h16v13H4zM8 9l2.5 2.5L16 8m-8 7h8" />
    </svg>
  );
}

function FtpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="16" height="6" rx="1.5" />
      <rect x="4" y="14" width="16" height="6" rx="1.5" />
      <circle cx="8" cy="7" r="1" />
      <circle cx="8" cy="17" r="1" />
    </svg>
  );
}

function LanguageIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4c2.2 2.1 3.3 4.8 3.3 8S14.2 17.9 12 20c-2.2-2.1-3.3-4.8-3.3-8S9.8 6.1 12 4" />
    </svg>
  );
}
