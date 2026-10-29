import React from "react";
import ReactDOM from "react-dom/client";
import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import "./index.css";
import "./training.css";
import "./models.css";

// antd 主题对齐现有视觉语言(--primary/#3157d5、圆角 8、正文 13px)
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#3157d5",
          borderRadius: 8,
          fontSize: 13,
          colorBgLayout: "#f7f8fb",
          colorBorder: "#cbd5e1",
          colorText: "#172033",
        },
        components: {
          Layout: {
            headerBg: "#f5f7fc",
            headerColor: "#172033",
            siderBg: "#ffffff",
          },
        },
      }}
    >
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
