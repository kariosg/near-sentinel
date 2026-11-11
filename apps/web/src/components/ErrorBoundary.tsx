import { Component, type ReactNode } from "react";
import { ErrorBox } from "./ui";

/**
 * Contains a rendering error to the current page, so one broken view can never blank the
 * whole dashboard. Reset by navigating (the boundary is keyed by route).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error("[sentinel] page render error", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="space-y-3">
          <ErrorBox error={new Error(`This page failed to render: ${this.state.error instanceof Error ? this.state.error.message : String(this.state.error)}`)} />
          <button type="button" className="text-sm text-link underline underline-offset-2 hover:no-underline" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
