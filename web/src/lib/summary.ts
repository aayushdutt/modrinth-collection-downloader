import { someOf } from "./describe";
import { formatBytes, listOf, loaderName } from "./format";
import type { ItemProgress, Job, Target } from "./install";
import type { PlanItem } from "./resolve";

export interface SummaryLine {
  text: string;
  /** A one-click fix offered next to the line. */
  action?: "show-problems" | "allow-alphas";
}

/** A short account of what will be downloaded, and what won't and why. */
export function planSummary(
  items: PlanItem[],
  jobs: Job[],
  skipped: Set<string>,
  { gameVersion, loader, nameOf }: { gameVersion: string; loader: string; nameOf(id: string): string },
): SummaryLine[] {
  const names = (list: PlanItem[]) => someOf(list.map((i) => nameOf(i.id)));
  const bytes = jobs.reduce((n, j) => n + j.item.file.size, 0);
  const lines: SummaryLine[] = [
    {
      text: jobs.length
        ? `${jobs.length} ${jobs.length === 1 ? "file" : "files"} ready (${formatBytes(bytes)}).`
        : skipped.size
          ? "Everything's skipped."
          : "Nothing available for this version.",
    },
  ];

  const missing = items.filter((i) => i.problem === "no-version" || i.problem === "no-file" || i.problem === "pin-incompatible");
  if (missing.length) {
    const where = `${gameVersion}${missing.some((i) => i.kind === "mod") ? ` ${loaderName(loader)}` : ""}`;
    lines.push(
      missing.length <= 3
        ? { text: `Not available for ${where}: ${names(missing)}.` }
        : { text: `${missing.length} aren't available for ${where}.`, action: "show-problems" },
    );
    // With betas allowed by default, the only fallback left to offer is an alpha.
    const alphas = missing.filter((i) => i.fallback === "alpha").length;
    if (alphas) {
      lines.push({
        text: alphas === missing.length ? `${alphas === 1 ? "It has" : "They have"} an alpha.` : `${alphas} have an alpha.`,
        action: "allow-alphas",
      });
    }
  }

  const blocked = items.filter((i) => i.problem === "missing-dependency");
  if (blocked.length) {
    const one = blocked.length === 1;
    lines.push({
      text: `Left out because ${one ? "a dependency isn't" : "dependencies aren't"} available: ${names(blocked)}.`,
    });
  }

  const conflicts = items.filter((i) => i.problem === "conflict");
  if (conflicts.length) lines.push({ text: `Mods need different versions of ${names(conflicts)}.` });

  const unsupported = items.filter((i) => i.problem === "unsupported");
  const modpacks = unsupported.filter((i) => i.project?.project_type === "modpack");
  if (modpacks.length) {
    const one = modpacks.length === 1;
    lines.push({ text: `${names(modpacks)} ${one ? "is a modpack" : "are modpacks"}. Install ${one ? "it" : "them"} from your launcher.` });
  }
  const otherTypes = unsupported.filter((i) => i.project?.project_type !== "modpack");
  if (otherTypes.length) lines.push({ text: `Can't download as files: ${names(otherTypes)}.` });

  const gone = items.filter((i) => i.problem === "unavailable");
  if (gone.length) lines.push({ text: `${gone.length} no longer on Modrinth.` });

  const betas = jobs.filter((j) => j.item.version.version_type === "beta").length;
  const alphaJobs = jobs.filter((j) => j.item.version.version_type === "alpha").length;
  if (betas) lines.push({ text: `${betas} ${betas === 1 ? "is a beta" : "are betas"}.` });
  if (alphaJobs) lines.push({ text: `${alphaJobs} ${alphaJobs === 1 ? "is an alpha" : "are alphas"}.` });

  const neededSkips = [...skipped].filter((id) => items.some((i) => i.deps.includes(id)));
  if (neededSkips.length) lines.push({ text: `You skipped ${listOf(neededSkips.map(nameOf))}, which other mods need.` });

  return lines;
}

export function countStates(progress: Record<string, ItemProgress>, ...states: ItemProgress["state"][]) {
  return Object.values(progress).filter((p) => states.includes(p.state)).length;
}

/** One line saying how an install or download ended. */
export function installResult({
  target,
  stopped,
  progress,
  savedAs,
  recovery = [],
}: {
  target: Target;
  stopped: boolean;
  progress: Record<string, ItemProgress>;
  savedAs: string | null;
  recovery?: string[];
}) {
  const count = (...states: ItemProgress["state"][]) => countStates(progress, ...states);
  if (target === "folder" && recovery.length) return "Installation needs recovery. Some files could not be restored.";
  if (stopped) {
    if (target === "zip") return "Stopped. Nothing saved.";
    const saved = count("added", "updated");
    return saved ? `Stopped after installing ${saved}.` : "Stopped. Nothing installed.";
  }
  if (target === "zip") return savedAs ? `Downloaded ${savedAs}` : "Nothing could be downloaded.";
  const parts = [
    count("added") && `installed ${count("added")}`,
    count("updated") && `updated ${count("updated")}`,
    count("current") && `${count("current")} already up to date`,
    count("kept") && `kept ${count("kept")} existing`,
  ].filter(Boolean) as string[];
  const text = parts.length ? listOf(parts) : "nothing changed";
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}
