import React from "react";

type Props = { children: React.ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: "100dvh", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 10, padding: 24,
          background: "#f6f3ec", color: "#9a3b2f", font: "14px/1.5 system-ui,sans-serif", textAlign: "center",
        }}>
          <div style={{ fontWeight: 700, color: "#1b1812" }}>界面出错了</div>
          <div style={{ fontSize: 12.5, color: "#8a8069", maxWidth: "28rem" }}>{this.state.error.message}</div>
          <button
            type="button"
            onClick={() => location.reload()}
            style={{
              marginTop: 8, border: "none", borderRadius: 10, padding: "10px 16px",
              background: "#e85a1e", color: "#fff", fontWeight: 600, cursor: "pointer",
            }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
