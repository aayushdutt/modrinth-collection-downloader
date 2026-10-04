import { Component, type ReactNode } from "react";

/** If rendering ever throws, show a way out instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="mx-auto w-full max-w-[calc(var(--s)*176+2rem)] px-4 pt-20">
        <section role="alert" className="gui px-[calc(var(--s)*6)] py-[calc(var(--s)*6)]">
          <h1 className="font-pixel text-[20px] text-ink">Something broke</h1>
          <p className="mt-2 text-[15px]">Reload the page to start again. Your files on disk haven't been touched.</p>
          <button type="button" className="mc-button mc-button-primary mt-4 text-[16px]" onClick={() => location.reload()}>
            Reload
          </button>
        </section>
      </main>
    );
  }
}
