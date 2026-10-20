export type AppLocale = "zh" | "en";

const STORAGE_KEY = "yolowebagent-starter-locale";

export function readLocale(): AppLocale {
  return window.localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "zh";
}

export function saveLocale(locale: AppLocale): void {
  window.localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
}

export const localeText = {
  zh: {
    datasets: "数据集",
    dataSources: "数据源",
    classLibrary: "类别库",
    ftp: "FTP 管理",
    training: "训练",
    models: "模型",
    agent: "智能体",
    samSettings: "SAM 设置",
    languageSettings: "语言设置",
    logs: "日志",
    settingsGroup: "设置",
    workspaceGroup: "工作区",
    mainNav: "主导航",
  },
  en: {
    datasets: "Datasets",
    dataSources: "Data sources",
    classLibrary: "Classes",
    ftp: "FTP",
    training: "Training",
    models: "Models",
    agent: "Agent",
    samSettings: "SAM settings",
    languageSettings: "Language",
    logs: "Logs",
    settingsGroup: "Settings",
    workspaceGroup: "Workspace",
    mainNav: "Main navigation",
  },
} as const;
