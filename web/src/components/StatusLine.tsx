import type { InstallFlow } from "../hooks/useInstallFlow";
import { someOf } from "../lib/describe";
import { formatBytes } from "../lib/format";
import { countStates, installResult, type SummaryLine } from "../lib/summary";
import { TextButton } from "./TextButton";

const ACTIONS: Record<NonNullable<SummaryLine["action"]>, string> = {
  "show-problems": "Show them",
  "allow-alphas": "Use alphas",
};

/** One place that says what's happening: checking, the plan, progress, or the result. */
export function StatusLine({
  flow,
  resolving,
  resolveError,
  checked,
  rootCount,
  throttled,
  summary,
  totalBytes,
  jobCount,
  onlyProblems,
  nameOf,
  onRetry,
  onAction,
}: {
  flow: InstallFlow;
  resolving: boolean;
  resolveError: string | null;
  checked: number;
  rootCount: number;
  throttled: boolean;
  summary: SummaryLine[];
  totalBytes: number;
  jobCount: number;
  onlyProblems: boolean;
  nameOf(id: string): string;
  onRetry(): void;
  onAction(action: NonNullable<SummaryLine["action"]>): void;
}) {
  let content;
  if (resolveError) {
    content = (
      <p className="font-bold text-danger">
        {resolveError} <TextButton onClick={onRetry}>Try again</TextButton>
      </p>
    );
  } else if (resolving) {
    content = (
      <>
        <p>
          Checking versions…{" "}
          {checked > rootCount ? `${rootCount} + ${checked - rootCount} dependencies` : `${checked} of ${rootCount}`}
        </p>
        {throttled && <p>Modrinth is rate limiting. Big collections take about a minute per 300 mods.</p>}
      </>
    );
  } else if (flow.phase === "running") {
    const done = countStates(flow.progress, "added", "updated", "current", "kept", "failed", "stopped");
    const bytes = Object.values(flow.progress).reduce((n, p) => n + p.bytes, 0);
    content = (
      <p>
        {flow.stage === "scanning"
          ? "Checking your folder…"
          : flow.stage === "packing"
            ? "Building the zip…"
            : `Downloading ${done} of ${jobCount} (${formatBytes(Math.min(bytes, totalBytes))} of ${formatBytes(totalBytes)})`}
      </p>
    );
  } else if (flow.phase === "done") {
    const failed = Object.entries(flow.progress)
      .filter(([, p]) => p.state === "failed")
      .map(([id]) => nameOf(id));
    content = (
      <>
        <p className="font-bold">{installResult(flow)}</p>
        {flow.target === "zip" && flow.savedAs && (
          <p>
            Unzip it and copy each folder's files into the same folder in your game (mods into mods). Remove older
            versions of these mods first.
          </p>
        )}
        {failed.length > 0 && (
          <p className="text-danger">Failed: {someOf(failed, 4)}. Hover for details, then try again.</p>
        )}
      </>
    );
  } else {
    content = summary.map((line, i) => (
      <p key={i} className={i === 0 ? "font-bold" : ""}>
        {line.text}
        {line.action && !(line.action === "show-problems" && onlyProblems) && (
          <>
            {" "}
            <TextButton onClick={() => onAction(line.action!)}>{ACTIONS[line.action]}</TextButton>
          </>
        )}
      </p>
    ));
  }

  return (
    <div aria-live="polite" className="min-h-6 space-y-1 text-[15px] leading-snug">
      {content}
    </div>
  );
}
