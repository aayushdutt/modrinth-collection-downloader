import { listOf, loaderName } from "./format";
import type { ItemProgress, Target } from "./install";
import type { PlanItem } from "./resolve";
import type { Project } from "./types";

/** One line of an item tooltip, coloured like Minecraft chat text. */
export interface Line {
  text: string;
  color?: string;
  italic?: boolean;
}

const GRAY = "#aaaaaa";
const DARK_GRAY = "#555555";
const GREEN = "#55ff55";
const YELLOW = "#ffff55";
const RED = "#ff5555";
const BLUE = "#5555ff";

/** "A, B, C and 2 more" */
export function someOf(names: string[], max = 3) {
  return listOf(names.length > max ? [...names.slice(0, max), `${names.length - max} more`] : names);
}

export function problemText(
  item: PlanItem,
  { gameVersion, loader, nameOf }: { gameVersion: string; loader: string; nameOf(id: string): string },
) {
  const target = item.kind === "mod" ? `${gameVersion} ${loaderName(loader)}` : gameVersion;
  switch (item.problem) {
    case "no-version":
      return item.kind === "mod" ? `No ${gameVersion} build for ${loaderName(loader)}` : `No version for ${gameVersion}`;
    case "pin-incompatible":
      if (!item.pinned) return "Needs a version that isn't on Modrinth";
      return item.fallback
        ? `Needs ${item.pinned.version_number}, a ${item.fallback}`
        : `Needs ${item.pinned.version_number}, which isn't for ${target}`;
    case "conflict":
      return "Mods need different versions of this";
    case "missing-dependency":
      return item.blockedBy.length ? `Needs ${someOf(item.blockedBy.map(nameOf))}` : "Needs a dependency that isn't on Modrinth";
    case "unsupported":
      return item.project?.project_type === "modpack" ? "Modpacks install through a launcher" : "Can't be installed as a file";
    case "unavailable":
      return "Not found on Modrinth";
    case "no-file":
      return "This version has no file to download";
    default:
      return null;
  }
}

export function progressText(progress: ItemProgress | undefined, target: Target): Line | null {
  switch (progress?.state) {
    case "waiting":
      return { text: "Waiting", color: GRAY };
    case "downloading":
      return { text: "Downloading", color: GRAY };
    case "added":
      return { text: target === "zip" ? "In the zip" : "Installed", color: GREEN };
    case "updated":
      return { text: "Updated", color: GREEN };
    case "current":
      return { text: "Up to date", color: GREEN };
    case "kept":
      return { text: "Kept yours", color: GRAY };
    case "stopped":
      return { text: "Stopped", color: GRAY };
    case "failed":
      return { text: `Failed: ${progress.error ?? "unknown error"}`, color: RED };
    default:
      return null;
  }
}

export interface SlotContext {
  gameVersion: string;
  loader: string;
  target: Target;
  busy: boolean;
  nameOf(id: string): string;
}

/** Tooltip lines and an accessible label for one slot. */
export function describeSlot(
  project: Project | null,
  item: PlanItem | undefined,
  { skipped, progress }: { skipped: boolean; progress?: ItemProgress },
  ctx: SlotContext,
) {
  const title = project?.title ?? "Unknown project";
  const lines: Line[] = [{ text: title }];
  if (item?.version) lines.push({ text: item.version.version_number, color: GRAY });
  const channel = item?.version?.version_type;
  if (channel === "beta") lines.push({ text: "Beta build", color: YELLOW });
  if (channel === "alpha") lines.push({ text: "Alpha build", color: RED });
  const problem = item ? problemText(item, ctx) : null;
  if (problem) lines.push({ text: problem, color: RED });
  if (item?.fallback) lines.push({ text: `${item.fallback === "beta" ? "Beta" : "Alpha"} available`, color: GRAY });
  if (item?.requiredBy.length) lines.push({ text: `Required by ${someOf(item.requiredBy.map(ctx.nameOf))}`, color: GRAY });
  if (!item) lines.push({ text: "Checking versions", color: GRAY });
  const status = skipped ? null : progressText(progress, ctx.target);
  if (status) lines.push(status);
  if (item && !item.problem) {
    lines.push({ text: `Goes in ${item.folder}`, color: BLUE, italic: true });
    if (!ctx.busy) lines.push({ text: skipped ? "Skipped, click to add back" : "Click to skip", color: DARK_GRAY });
  }
  const label = [title, problem ?? (skipped ? "skipped" : "included"), status?.text].filter(Boolean).join(", ");
  return { lines, label };
}
