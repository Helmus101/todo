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

// TEMP DIAGNOSTIC — remove once the live "tasks won't open on mobile" bug is confirmed fixed. React's
// error boundary below only catches RENDER errors, never errors thrown inside an event handler (like a
// button's onClick) — so if tapping a task were silently throwing there, it would be completely invisible
// without devtools. This puts any uncaught error or unhandled promise rejection directly on the page as
// plain visible text, so a phone with no console access can still tell us if something is actually failing.
if (typeof window !== "undefined") {
  const showCrash = (label: string, err: unknown) => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:auto 8px 8px 8px;z-index:99999;background:#c6462f;color:#fff;padding:10px 12px;border-radius:8px;font:12px monospace;max-height:40vh;overflow:auto;white-space:pre-wrap;";
    box.textContent = `${label}: ${err instanceof Error ? (err.message + "\n" + (err.stack || "")) : String(err)}`;
    document.body.appendChild(box);
  };
  window.addEventListener("error", (e) => showCrash("JS error", e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => showCrash("Unhandled promise rejection", e.reason));
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
