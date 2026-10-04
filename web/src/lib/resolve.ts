import { CHANNELS, type Channel, type Project, type Version, type VersionFile } from "./types";

export type Folder = "mods" | "resourcepacks" | "shaderpacks";
export type Kind = "mod" | "resourcepack" | "shader" | "unsupported";

export function kindOf(project: Pick<Project, "project_type">): Kind {
  switch (project.project_type) {
    case "mod":
    case "resourcepack":
    case "shader":
      return project.project_type;
    default:
      // Modpacks are installed by launchers, not dropped into a folder.
      return "unsupported";
  }
}

export function folderFor(kind: Kind, isDependency: boolean): Folder {
  // Dependencies are libraries; the CLI keeps them in mods/ regardless of type.
  if (isDependency) return "mods";
  if (kind === "resourcepack") return "resourcepacks";
  if (kind === "shader") return "shaderpacks";
  return "mods";
}

/** Whether a version's loaders satisfy the chosen loader for this kind of project. */
export function matchesLoader(loaders: string[], loader: string, kind: Kind): boolean {
  if (loaders.includes(loader)) return true;
  // Resource packs are tagged with loader "minecraft"; shaders with iris/optifine/etc.
  if (kind === "resourcepack") return loaders.includes("minecraft");
  return kind === "shader";
}

/** Prefer a release, then each allowed prerelease channel; keep the API's newest-first order. */
export function selectVersion(
  versions: Version[],
  gameVersion: string,
  loader: string,
  kind: Kind,
  maxChannel: Channel = "release",
): Version | null {
  const allowed = CHANNELS.slice(0, CHANNELS.indexOf(maxChannel) + 1);
  const matching = versions.filter(
    (v) => v.game_versions.includes(gameVersion) && matchesLoader(v.loaders, loader, kind),
  );
  for (const channel of allowed) {
    const found = matching.find((v) => (v.version_type ?? "release") === channel);
    if (found) return found;
  }
  return null;
}

export function primaryFile(version: Version): VersionFile | null {
  return version.files.find((f) => f.primary) ?? version.files[0] ?? null;
}

/**
 * Name files the way the CLI does, `name.<projectId>.ext`, so either tool can
 * recognise and update what the other installed.
 */
export function fileNameWithId(filename: string, projectId: string): string {
  const parts = filename.split(".");
  parts.splice(Math.max(parts.length - 1, 0), 0, projectId);
  return parts.join(".");
}

/** Inverse of fileNameWithId: the second-to-last dot segment, or null. */
export function idFromFileName(name: string): string | null {
  const parts = name.split(".");
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

/** How many installable projects list support for each game version with this loader. */
export function coverage(projects: Project[], loader: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of projects) {
    const kind = kindOf(p);
    if (kind === "unsupported" || !matchesLoader(p.loaders, loader, kind)) continue;
    for (const v of p.game_versions) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

/** Mod loaders offered by the collection, most common first. */
export function loadersIn(projects: Project[]): string[] {
  const counts = new Map<string, number>();
  for (const p of projects) {
    if (kindOf(p) !== "mod") continue;
    for (const l of p.loaders) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const preferred = ["fabric", "neoforge", "quilt", "forge"];
  return [...counts.keys()]
    .filter((l) => preferred.includes(l))
    .sort((a, b) => counts.get(b)! - counts.get(a)! || preferred.indexOf(a) - preferred.indexOf(b));
}

export type Problem =
  | "no-version"
  | "unsupported"
  | "unavailable"
  | "no-file"
  /** A mod pins an exact version that doesn't fit this version, loader or channel. */
  | "pin-incompatible"
  /** Mods pin different exact versions of this project. */
  | "conflict"
  /** A required dependency has one of the problems above, so this won't start. */
  | "missing-dependency";

export interface PlanItem {
  id: string;
  project: Project | null;
  kind: Kind;
  role: "collection" | "dependency";
  requiredBy: string[];
  version: Version | null;
  file: VersionFile | null;
  folder: Folder;
  problem: Problem | null;
  /** When nothing matched, the prerelease channel that would have. */
  fallback: Channel | null;
  /** The exact version another mod requires, when one does. */
  pinned: Version | null;
  /** For "missing-dependency": the direct dependencies that are unavailable. */
  blockedBy: string[];
  deps: string[];
}

export interface PlanApi {
  getProjects(ids: string[]): Promise<Project[]>;
  getProjectVersions(id: string, gameVersion: string): Promise<Version[]>;
  getVersions(ids: string[]): Promise<Version[]>;
  pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void>;
}

export interface PlanOptions {
  gameVersion: string;
  loader: string;
  channel: Channel;
}

type Pins = Map<string, Set<string>>;

const sameSet = (a = new Set<string>(), b = new Set<string>()) => a.size === b.size && [...a].every((v) => b.has(v));
const samePins = (a: Pins, b: Pins) => [...new Set([...a.keys(), ...b.keys()])].every((id) => sameSet(a.get(id), b.get(id)));

/** Whether an exact version can be used for this game version, loader and channel. */
function pinFits(version: Version, kind: Kind, opts: PlanOptions) {
  const channel = version.version_type ?? "release";
  return {
    target: version.game_versions.includes(opts.gameVersion) && matchesLoader(version.loaders, opts.loader, kind),
    channel: CHANNELS.indexOf(channel) <= CHANNELS.indexOf(opts.channel),
  };
}

/**
 * Resolve the collection and every required dependency. Exact version pins
 * can only be discovered by resolving their parents, so this repeats until
 * the pins stop changing, as the CLI does. Versions are cached by the caller's
 * API, so repeat passes are cheap. `known` reuses project data already fetched.
 */
export async function buildPlan(
  api: PlanApi,
  rootIds: string[],
  known: Map<string, Project>,
  opts: PlanOptions,
  onItem?: (item: PlanItem) => void,
): Promise<Map<string, PlanItem>> {
  const projects = new Map(known);
  const exact = new Map<string, Version | null>();
  const exactVersions = async (ids: string[]) => {
    const missing = [...new Set(ids)].filter((id) => !exact.has(id));
    if (missing.length) {
      const found = new Map((await api.getVersions(missing)).map((v) => [v.id, v]));
      for (const id of missing) exact.set(id, found.get(id) ?? null);
    }
  };

  let pins: Pins = new Map();
  const seen: Pins[] = [];
  for (let pass = 0; pass < 10; pass++) {
    const { items, nextPins } = await resolvePass(api, rootIds, projects, exactVersions, exact, pins, opts, onItem);
    onItem = undefined; // Progress counts the first pass only.
    if (samePins(pins, nextPins)) return blockDependents(items);
    if (seen.some((p) => samePins(p, nextPins))) {
      // The pins oscillate between incompatible choices: refuse those projects.
      for (const id of new Set([...pins.keys(), ...nextPins.keys()])) {
        const item = items.get(id);
        if (item && !sameSet(pins.get(id), nextPins.get(id))) {
          Object.assign(item, { problem: "conflict", version: null, file: null });
        }
      }
      return blockDependents(items);
    }
    seen.push(pins);
    pins = nextPins;
  }
  throw new Error("Dependency versions didn't settle");
}

async function resolvePass(
  api: PlanApi,
  rootIds: string[],
  projects: Map<string, Project>,
  exactVersions: (ids: string[]) => Promise<void>,
  exact: Map<string, Version | null>,
  pins: Pins,
  opts: PlanOptions,
  onItem?: (item: PlanItem) => void,
) {
  const items = new Map<string, PlanItem>();
  const nextPins: Pins = new Map();
  // Project id -> the ids that require it (empty for collection entries).
  let frontier = new Map<string, string[]>(rootIds.map((id) => [id, []]));

  while (frontier.size) {
    const missing = [...frontier.keys()].filter((id) => !projects.has(id));
    if (missing.length) {
      for (const p of await api.getProjects(missing)) projects.set(p.id, p);
    }
    await exactVersions([...frontier.keys()].flatMap((id) => [...(pins.get(id) ?? [])]));

    const edges: { id: string; parent: string }[] = [];
    const pinned: { versionId: string; projectId: string | null; parent: string }[] = [];

    await api.pool([...frontier], 6, async ([id, parents]) => {
      const project = projects.get(id) ?? null;
      const kind = project ? kindOf(project) : "unsupported";
      const isDep = parents.length > 0;
      const item: PlanItem = {
        id,
        project,
        kind,
        role: isDep ? "dependency" : "collection",
        requiredBy: [...parents],
        version: null,
        file: null,
        folder: folderFor(kind, isDep),
        problem: null,
        fallback: null,
        pinned: null,
        blockedBy: [],
        deps: [],
      };
      items.set(id, item);
      const pin = [...(pins.get(id) ?? [])];

      if (!project) item.problem = "unavailable";
      else if (kind === "unsupported") item.problem = "unsupported";
      else if (pin.length > 1) item.problem = "conflict";
      else if (pin.length === 1) {
        const version = exact.get(pin[0]) ?? null;
        item.pinned = version;
        const fits = version && version.project_id === id ? pinFits(version, kind, opts) : null;
        if (!version || !fits?.target) item.problem = "pin-incompatible";
        else if (!fits.channel) {
          item.problem = "pin-incompatible";
          item.fallback = version.version_type;
        } else item.version = version;
      } else {
        const versions = await api.getProjectVersions(id, opts.gameVersion);
        item.version = selectVersion(versions, opts.gameVersion, opts.loader, kind, opts.channel);
        if (!item.version) {
          item.problem = "no-version";
          item.fallback =
            opts.channel === "alpha"
              ? null
              : (selectVersion(versions, opts.gameVersion, opts.loader, kind, "alpha")?.version_type ?? null);
        }
      }
      if (item.version) {
        item.file = primaryFile(item.version);
        if (!item.file) item.problem = "no-file";
        for (const dep of item.version.dependencies) {
          if (dep.dependency_type !== "required") continue;
          if (dep.version_id) pinned.push({ versionId: dep.version_id, projectId: dep.project_id, parent: id });
          else if (dep.project_id) edges.push({ id: dep.project_id, parent: id });
        }
      }
      onItem?.(item);
    });

    // Exact pins: find which project each belongs to, and require that version.
    await exactVersions(pinned.map((p) => p.versionId));
    for (const { versionId, projectId, parent } of pinned) {
      const owner = exact.get(versionId)?.project_id ?? projectId;
      if (!owner) {
        // Neither the version nor a project is known: the parent can't be satisfied.
        Object.assign(items.get(parent)!, { problem: "missing-dependency" });
        continue;
      }
      if (!nextPins.has(owner)) nextPins.set(owner, new Set());
      nextPins.get(owner)!.add(versionId);
      edges.push({ id: owner, parent });
    }

    frontier = new Map();
    for (const { id, parent } of edges) {
      if (id === parent) continue;
      const parentItem = items.get(parent)!;
      if (!parentItem.deps.includes(id)) parentItem.deps.push(id);
      const existing = items.get(id);
      const parents = existing ? existing.requiredBy : (frontier.get(id) ?? []);
      if (!parents.includes(parent)) parents.push(parent);
      if (!existing) frontier.set(id, parents);
    }
  }
  return { items, nextPins };
}

/**
 * A mod whose required dependency is unavailable won't start, so it's left
 * out too, all the way up the chain. Dependency cycles are fine on their own.
 */
function blockDependents(items: Map<string, PlanItem>) {
  for (let changed = true; changed; ) {
    changed = false;
    for (const item of items.values()) {
      if (item.problem) continue;
      const blockedBy = item.deps.filter((d) => items.get(d)?.problem);
      if (blockedBy.length) {
        Object.assign(item, { problem: "missing-dependency", blockedBy });
        changed = true;
      }
    }
  }
  return items;
}

/**
 * Everything that will be installed: the collection entries the user kept,
 * plus whatever they transitively require. Skipped ids are never pulled in.
 */
export function installSet(
  items: Map<string, PlanItem>,
  rootIds: string[],
  skipped: Set<string>,
): Set<string> {
  const out = new Set<string>();
  const stack = rootIds.filter((id) => !skipped.has(id));
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id) || skipped.has(id)) continue;
    const item = items.get(id);
    if (!item) continue;
    out.add(id);
    stack.push(...item.deps);
  }
  return out;
}
