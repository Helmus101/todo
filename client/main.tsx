import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

/** Last-resort error boundary: if any render throws (e.g. malformed task data), show a recoverable
 *  fallback instead of a blank white screen — credibility-critical for production. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error("[otto] render error:", error); }
  render() {
    if (this.state.error) {
      return (
        <div className="screen crash">
          <div className="crash-card">
            <h1>Something went wrong</h1>
            <p>Otto hit an unexpected error. Reloading usually fixes it.</p>
            <button className="btn primary big" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Register service worker for PWA support
if ("serviceWorker" in navigator && window.location.protocol === "https:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[sw] registration failed:", err);
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
