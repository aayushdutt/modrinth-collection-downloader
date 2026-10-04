import { coverage, kindOf, loadersIn } from "./resolve";
import type { GameVersionTag, Project } from "./types";

/** The newest release version supported by the most projects. */
export function bestVersion(counts: Map<string, number>, tags: GameVersionTag[]) {
  const releases = tags.filter((t) => t.version_type === "release").map((t) => t.version);
  const candidates = releases.length ? releases.filter((v) => counts.has(v)) : [...counts.keys()];
  let best = "";
  for (const v of candidates) if (!best || counts.get(v)! > counts.get(best)!) best = v;
  return best || [...counts.keys()][0] || "";
}

/**
 * The most widely supported releases as quick picks, every other release in a
 * menu. Snapshots and pre-releases are left out: they're rarely what anyone wants.
 */
export function versionChoices(counts: Map<string, number>, tags: GameVersionTag[], quick = 5) {
  const order = tags.length ? tags.map((t) => t.version) : [...counts.keys()].sort().reverse();
  const releases = new Set(tags.filter((t) => t.version_type === "release").map((t) => t.version));
  const available = order.filter((v) => counts.has(v) && (!tags.length || releases.has(v)));
  const chips = [...available]
    .sort((a, b) => counts.get(b)! - counts.get(a)! || order.indexOf(a) - order.indexOf(b))
    .slice(0, quick)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { chips, others: available.filter((v) => !chips.includes(v)) };
}

/** Projects that can be installed as files; the denominator for coverage counts. */
export const installableCount = (projects: Project[]) => projects.filter((p) => kindOf(p) !== "unsupported").length;

/**
 * Keep the current loader and version when the collection supports them
 * (e.g. from a shared link); otherwise choose the best-supported ones.
 */
export function pickTarget(
  projects: Project[],
  current: { gameVersion: string; loader: string },
  tags: GameVersionTag[],
) {
  const loaders = loadersIn(projects);
  const loader = loaders.includes(current.loader) ? current.loader : (loaders[0] ?? "fabric");
  const counts = coverage(projects, loader);
  const gameVersion = counts.has(current.gameVersion) ? current.gameVersion : bestVersion(counts, tags);
  return { loader, gameVersion };
}
