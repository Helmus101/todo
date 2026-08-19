import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
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

// React's error boundary below only catches RENDER errors, never errors thrown inside an event handler
// (like a button's onClick) — those go straight to the console here instead of crashing silently. DEV-only
// on-screen box (a real phone with no devtools needs SOME way to see it while debugging); production users
// never see a raw stack trace dumped over the UI — that's a debug tool, not something to ship.
if (typeof window !== "undefined") {
  const logCrash = (label: string, err: unknown) => {
    console.error(`[otto] ${label}:`, err);
    if (!import.meta.env.DEV) return;
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:auto 8px 8px 8px;z-index:99999;background:#c6462f;color:#fff;padding:10px 12px;border-radius:8px;font:12px monospace;max-height:40vh;overflow:auto;white-space:pre-wrap;";
    box.textContent = `${label}: ${err instanceof Error ? (err.message + "\n" + (err.stack || "")) : String(err)}`;
    document.body.appendChild(box);
  };
  window.addEventListener("error", (e) => logCrash("JS error", e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => logCrash("Unhandled promise rejection", e.reason));
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
      {/* No-ops safely when not served from Vercel (self-hosted deploys) — collects page views only. */}
      <Analytics />
    </ErrorBoundary>
  </StrictMode>
);
