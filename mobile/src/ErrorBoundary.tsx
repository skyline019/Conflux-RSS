import React from "react";
import packageJson from "../package.json";

const APP_VERSION = String((packageJson as { version?: string }).version || "0.2.5");

type Props = { children: React.ReactNode };
type State = { error: Error | null };

async function exportDiagnostics(error: Error) {
  const payload = {
    appVersion: APP_VERSION,
    at: new Date().toISOString(),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    message: error.message,
    stack: error.stack || "",
  };
  const text = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    return "诊断已复制到剪贴板";
  } catch {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `conflux-diagnostics-${APP_VERSION}.json`;
    a.click();
    URL.revokeObjectURL(url);
    return "诊断文件已下载";
  }
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      const err = this.state.error;
      return (
        <div style={{
          minHeight: "100%", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 10, padding: 24,
          background: "#f6f3ec", color: "#9a3b2f", font: "14px/1.5 system-ui,sans-serif", textAlign: "center",
        }}>
          <div style={{ fontWeight: 700, color: "#1b1812" }}>界面出错了</div>
          <div style={{ fontSize: 12.5, color: "#8a8069", maxWidth: "28rem" }}>{err.message}</div>
          <div style={{ fontSize: 11, color: "#b0a78f" }}>汇阅 {APP_VERSION}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 8 }}>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              style={{
                border: "1px solid #ddd3ba", borderRadius: 10, padding: "10px 16px",
                background: "#fff", color: "#1b1812", fontWeight: 600, cursor: "pointer",
              }}
            >
              重试
            </button>
            <button
              type="button"
              onClick={() => location.reload()}
              style={{
                border: "none", borderRadius: 10, padding: "10px 16px",
                background: "#e85a1e", color: "#fff", fontWeight: 600, cursor: "pointer",
              }}
            >
              重新加载
            </button>
            <button
              type="button"
              onClick={() => { void exportDiagnostics(err); }}
              style={{
                border: "1px solid #ddd3ba", borderRadius: 10, padding: "10px 16px",
                background: "#faf7ef", color: "#57503f", fontWeight: 600, cursor: "pointer",
              }}
            >
              导出诊断
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
