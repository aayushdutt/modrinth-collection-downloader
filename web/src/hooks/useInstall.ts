import { useCallback, useEffect, useRef, useState } from "react";
import type { InstallEvents, ItemProgress, Stage } from "../lib/install";

export type Phase = "idle" | "running" | "done";

/** Tracks an install run, batching per-chunk progress into one render per frame. */
export function useInstall() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState<Stage>("downloading");
  const [stopped, setStopped] = useState(false);
  const [progress, setProgress] = useState<Record<string, ItemProgress>>({});
  const live = useRef<Record<string, ItemProgress>>({});
  const frame = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const flush = useCallback(() => {
    frame.current ||= requestAnimationFrame(() => {
      frame.current = 0;
      setProgress({ ...live.current });
    });
  }, []);

  // Leaving mid-download would lose the work; ask first.
  useEffect(() => {
    if (phase !== "running") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  const run = useCallback(
    async <T,>(task: (events: InstallEvents, signal: AbortSignal) => Promise<T>): Promise<T> => {
      const abort = new AbortController();
      controller.current = abort;
      live.current = {};
      setProgress({});
      setStopped(false);
      setStage("downloading");
      setPhase("running");
      const events: InstallEvents = {
        onState(id, state, error) {
          live.current[id] = { bytes: live.current[id]?.bytes ?? 0, state, error };
          flush();
        },
        onBytes(id, delta) {
          const p = live.current[id] ?? { state: "downloading", bytes: 0 };
          live.current[id] = { ...p, bytes: p.bytes + delta };
          flush();
        },
        onStage: setStage,
      };
      try {
        return await task(events, abort.signal);
      } finally {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        controller.current = null;
        setProgress({ ...live.current });
        setStopped(abort.signal.aborted);
        setPhase("done");
      }
    },
    [flush],
  );

  const stop = useCallback(() => controller.current?.abort(), []);

  const reset = useCallback(() => {
    controller.current?.abort();
    live.current = {};
    setProgress({});
    setPhase("idle");
  }, []);

  return { phase, stage, stopped, progress, run, stop, reset };
}
