import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { redactSensitive } from "@/modules/ai/lib/redact";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

// Class component because error boundaries have no hook equivalent —
// `getDerivedStateFromError` / `componentDidCatch` only exist on classes. This
// wraps the whole app tree so a render/lifecycle crash shows recoverable UI
// instead of a blank white webview.
//
// It does NOT catch async callbacks, event handlers, or promise rejections —
// those are handled by installGlobalErrorHandler (window.onerror +
// unhandledrejection). The two layers are complementary.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const stack = redactSensitive(error.stack || String(error));
    console.error("[terax] render error boundary caught:", stack, info);
    // Best-effort forward to the Rust log; never let logging re-throw.
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("log_renderer_error", {
          message: `boundary: ${stack}`,
        }).catch(() => {}),
      )
      .catch(() => {});
  }

  // Clear the caught error so React re-mounts the child tree. Useful when the
  // crash was transient (e.g. a race that's since resolved).
  reset = (): void => {
    this.setState({ error: null });
  };

  reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const message = redactSensitive(error.message || "Unknown error");

    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-5 bg-background p-8 text-foreground">
        <div className="flex max-w-lg flex-col items-center gap-3 text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            The interface hit an unexpected error and couldn&apos;t render. You
            can try recovering, or reload the window.
          </p>
          <pre className="max-h-40 w-full overflow-auto rounded-md border border-border/60 bg-card p-3 text-left text-xs text-muted-foreground">
            {message}
          </pre>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={this.reset}>
            Try again
          </Button>
          <Button variant="default" onClick={this.reload}>
            Reload window
          </Button>
        </div>
      </div>
    );
  }
}
