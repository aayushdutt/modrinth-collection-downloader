import type { Collection, GameVersionTag, Project, Version } from "./types";

const API = "https://api.modrinth.com";

export class NotFoundError extends Error {}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

// Modrinth allows 300 requests a minute per IP and doesn't expose its
// rate-limit headers to browsers, so large collections back off on 429s.
// Listeners hear about it so the UI can say why things slowed down.
const throttleListeners = new Set<(waiting: boolean) => void>();
export function onThrottle(listener: (waiting: boolean) => void) {
  throttleListeners.add(listener);
  return () => void throttleListeners.delete(listener);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, init);
    if (res.ok) {
      if (attempt) throttleListeners.forEach((l) => l(false));
      return res.json() as Promise<T>;
    }
    if (res.status === 404) throw new NotFoundError(path);
    if ((res.status === 429 || res.status >= 500) && attempt < 8) {
      if (res.status === 429) throttleListeners.forEach((l) => l(true));
      await sleep(Math.min(1000 * 2 ** attempt, 20_000), init.signal ?? undefined);
      continue;
    }
    throw new Error(`Modrinth returned ${res.status} for ${path}`);
  }
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal });

const ids = (list: string[]) => encodeURIComponent(JSON.stringify(list));

export function getCollection(id: string, signal?: AbortSignal) {
  return get<Collection>(`/v3/collection/${encodeURIComponent(id)}`, signal);
}

/** Fetch many projects at once; unknown or private ids are silently absent. */
export async function getProjects(projectIds: string[], signal?: AbortSignal) {
  const out: Project[] = [];
  // Keep URLs comfortably short.
  for (let i = 0; i < projectIds.length; i += 100) {
    const chunk = projectIds.slice(i, i + 100);
    out.push(...(await get<Project[]>(`/v2/projects?ids=${ids(chunk)}`, signal)));
  }
  return out;
}

// Loader and channel filtering happens locally, so caching by game version
// makes switching loader or toggling alphas instant.
const versionCache = new Map<string, Promise<Version[]>>();

/** Versions of a project for one game version, newest first. */
export function getProjectVersions(projectId: string, gameVersion: string, signal?: AbortSignal) {
  const key = `${projectId}@${gameVersion}`;
  let cached = versionCache.get(key);
  if (!cached) {
    // Not tied to one caller's signal: a cancelled pass shouldn't poison the cache.
    cached = get<Version[]>(
      `/v2/project/${encodeURIComponent(projectId)}/version?game_versions=${ids([gameVersion])}`,
    );
    cached.catch(() => versionCache.delete(key));
    versionCache.set(key, cached);
  }
  if (!signal) return cached;
  return Promise.race([
    cached,
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason));
    }),
  ]);
}

export async function getVersions(versionIds: string[], signal?: AbortSignal) {
  if (!versionIds.length) return [];
  return get<Version[]>(`/v2/versions?ids=${ids(versionIds)}`, signal);
}

/** Identify files by SHA-1: which Modrinth version, if any, each one is. */
export async function getVersionsByHash(hashes: string[], signal?: AbortSignal) {
  const out: Record<string, Version> = {};
  for (let i = 0; i < hashes.length; i += 500) {
    Object.assign(
      out,
      await request<Record<string, Version>>("/v2/version_files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hashes: hashes.slice(i, i + 500), algorithm: "sha1" }),
        signal,
      }),
    );
  }
  return out;
}

export function getGameVersions(signal?: AbortSignal) {
  return get<GameVersionTag[]>("/v2/tag/game_version", signal);
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}
