import { Component, type ReactNode } from "react";
import { currentLang } from "../../api.ts";

/** One bad board entry (a malformed figure spec, a model-written expression) must not blank the whole tutor page — and a stored board would crash
 *  again on every reload. Each entry renders inside its own boundary; a failure shows a quiet one-line note instead. */
export class BlockBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { console.warn("[board] an entry could not be shown:", String((err as any)?.message || err).slice(0, 120)); }
  render() {
    if (!this.state.failed) return this.props.children;
    const en = currentLang() === "en";
    return <p className="sm-board-block-error" role="note">{"This part of the board couldn't be shown."}</p>;
  }
}
