import { getProjectVersions, getVersions, getVersionsByHash, pool } from "./modrinth";
import { fileNameWithId, idFromFileName, type Folder, type PlanItem } from "./resolve";
import type { Version } from "./types";
import { crc32, zip, ZIP_LIMIT, type ZipEntry } from "./zip";

export type Outcome = "added" | "updated" | "current" | "kept" | "failed" | "stopped";
export type JobState = "waiting" | "downloading" | Outcome;
export type Stage = "scanning" | "downloading" | "installing" | "packing";
export type Target = "folder" | "zip";

export interface ItemProgress {
  state: JobState;
  error?: string;
  bytes: number;
}

export interface Job {
  item: PlanItem & { file: NonNullable<PlanItem["file"]>; version: NonNullable<PlanItem["version"]> };
  name: string;
}

export interface InstallEvents {
  onState(id: string, state: JobState, error?: string): void;
  onBytes(id: string, delta: number): void;
  onStage?(stage: Stage): void;
  onRecovery?(directory: string): void;
}

export const FOLDERS: Folder[] = ["mods", "resourcepacks", "shaderpacks"];

export function jobsFor(items: Iterable<PlanItem>): Job[] {
  const jobs: Job[] = [];
  for (const item of items) {
    if (item.file && item.version && !item.problem) {
      jobs.push({ item: item as Job["item"], name: fileNameWithId(item.file.filename, item.id) });
    }
  }
  return jobs;
}

async function digest(algorithm: "SHA-1" | "SHA-512", data: Uint8Array<ArrayBuffer> | ArrayBuffer) {
  const hash = await crypto.subtle.digest(algorithm, data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** How long a download may go without receiving any bytes before it's retried. */
const STALL_MS = 30_000;
const ATTEMPTS = 3;

class DownloadError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

/** One download attempt, abandoned if it stalls. */
async function fetchOnce(job: Job, onBytes: (n: number) => void, signal: AbortSignal) {
  signal.throwIfAborted();
  const attempt = new AbortController();
  const forward = () => attempt.abort(signal.reason);
  signal.addEventListener("abort", forward);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => attempt.abort(new DownloadError("the download stalled", true)), STALL_MS);
  };
  try {
    watch();
    const res = await fetch(job.item.file.url, { signal: attempt.signal });
    if (!res.ok || !res.body) {
      throw new DownloadError(`download failed (${res.status})`, res.status === 429 || res.status >= 500);
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      watch();
      chunks.push(value);
      length += value.length;
      onBytes(value.length);
    }
    const data = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      data.set(c, at);
      at += c.length;
    }
    const expected = job.item.file.hashes.sha512;
    if (expected && (await digest("SHA-512", data)) !== expected) {
      throw new DownloadError("the file didn't match Modrinth's checksum", true);
    }
    return data;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", forward);
  }
}

/**
 * Download a file and check it against Modrinth's hash, retrying network
 * errors, stalls and corrupt transfers a couple of times.
 */
async function fetchVerified(job: Job, events: InstallEvents, signal: AbortSignal) {
  for (let attempt = 1; ; attempt++) {
    let received = 0;
    try {
      return await fetchOnce(
        job,
        (n) => {
          received += n;
          events.onBytes(job.item.id, n);
        },
        signal,
      );
    } catch (e) {
      events.onBytes(job.item.id, -received);
      const retryable = e instanceof DownloadError ? e.retryable : e instanceof TypeError; // TypeError: network failure
      if (signal.aborted || attempt >= ATTEMPTS || !retryable) throw e;
      await wait(1000 * attempt, signal);
    }
  }
}

/** Dependencies before the mods that need them; cycles are broken arbitrarily. */
export function dependencyOrder(jobs: Job[]) {
  const byId = new Map(jobs.map((j) => [j.item.id, j]));
  const order: Job[] = [];
  const visited = new Set<string>();
  const visit = (job: Job) => {
    if (visited.has(job.item.id)) return;
    visited.add(job.item.id);
    for (const dep of job.item.deps) {
      const depJob = byId.get(dep);
      if (depJob) visit(depJob);
    }
    order.push(job);
  };
  jobs.forEach(visit);
  return order;
}

/**
 * Run jobs dependency-first. A mod whose dependency failed isn't installed:
 * it wouldn't start, and its previous version (if any) stays in place.
 */
async function run(jobs: Job[], events: InstallEvents, signal: AbortSignal, fn: (job: Job) => Promise<Outcome>) {
  const order = dependencyOrder(jobs);
  const position = new Map(order.map((j, i) => [j.item.id, i]));
  const settled = new Map<string, Promise<Outcome>>();
  const settle = new Map<string, (outcome: Outcome) => void>();
  for (const job of order) {
    events.onState(job.item.id, "waiting");
    settled.set(job.item.id, new Promise((resolve) => settle.set(job.item.id, resolve)));
  }

  // Jobs only wait on dependencies earlier in the order, which a worker has
  // already started, so the pool can't deadlock.
  await pool(order, 4, async (job) => {
    const id = job.item.id;
    const deps = job.item.deps.filter((d) => (position.get(d) ?? Infinity) < position.get(id)!);
    const outcomes = await Promise.all(deps.map((d) => settled.get(d)!));
    const failedDep = deps.find((_, i) => outcomes[i] === "failed" || outcomes[i] === "stopped");
    let outcome: Outcome;
    let error: string | undefined;
    if (signal.aborted) outcome = "stopped";
    else if (failedDep) {
      outcome = "failed";
      error = `needs ${byTitle(jobs, failedDep)}, which didn't download`;
    } else {
      try {
        outcome = await fn(job);
      } catch (e) {
        outcome = signal.aborted || isAbort(e) ? "stopped" : "failed";
        if (outcome === "failed") error = e instanceof Error ? e.message : String(e);
      }
    }
    events.onState(id, outcome, error);
    settle.get(id)!(outcome);
  });
}

const byTitle = (jobs: Job[], id: string) => jobs.find((j) => j.item.id === id)?.item.project?.title ?? id;

interface Existing {
  folder: Folder;
  name: string;
  file: File;
  version: Version;
}

/**
 * Identify every copy by hash. A damaged managed file is only recognized
 * when its complete name matches a file actually published by that project.
 * A project ID in an unrelated filename is never enough to delete it.
 */
async function indexFolder(
  root: FileSystemDirectoryHandle,
  modsOnly: boolean,
  jobs: Job[],
  signal: AbortSignal,
) {
  const index = new Map<string, Existing[]>();
  const add = (id: string, entry: Existing) => index.set(id, [...(index.get(id) ?? []), entry]);
  const wanted = new Map(jobs.map((job) => [job.item.id, job]));
  const targets = new Map(jobs.map((job) => [`${job.item.folder}/${job.name}`, job.item.id]));
  const files: { folder: Folder; name: string; file: File }[] = [];

  for (const folder of modsOnly ? (["mods"] as Folder[]) : FOLDERS) {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = modsOnly ? root : await root.getDirectoryHandle(folder);
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotFoundError") continue;
      throw e;
    }
    for await (const handle of dir.values()) {
      if (handle.kind !== "file") continue;
      if (/\.(jar|zip)$/i.test(handle.name)) {
        files.push({ folder, name: handle.name, file: await (handle as FileSystemFileHandle).getFile() });
      }
    }
  }

  if (files.length) {
    const hashes = new Map<string, typeof files>();
    await pool(files, 4, async (entry) => {
      if (signal.aborted) return;
      if (entry.file.size > 512 * 1024 * 1024) return;
      const hash = await digest("SHA-1", await entry.file.arrayBuffer());
      hashes.set(hash, [...(hashes.get(hash) ?? []), entry]);
    });
    signal.throwIfAborted();
    // If identification fails, stop before writing: installing alongside an
    // unidentified hand-installed copy could leave a broken game instance.
    const found = await getVersionsByHash([...hashes.keys()], signal);
    const identified = new Set<(typeof files)[number]>();
    for (const [hash, version] of Object.entries(found)) {
      for (const entry of hashes.get(hash) ?? []) {
        const owner = targets.get(`${entry.folder}/${entry.name}`);
        if (owner && owner !== version.project_id) {
          throw new Error(`${entry.name} belongs to another Modrinth project. Move it before installing.`);
        }
        identified.add(entry);
        if (wanted.has(version.project_id)) add(version.project_id, { ...entry, version });
      }
    }

    const candidates = files.filter((entry) => !identified.has(entry) && wanted.has(idFromFileName(entry.name) ?? ""));
    const published = new Map<string, Version[]>();
    await pool([...new Set(candidates.map((entry) => idFromFileName(entry.name)!))], 4, async (id) => {
      const job = wanted.get(id)!;
      const older = candidates.some((entry) => idFromFileName(entry.name) === id && entry.name !== job.name);
      published.set(id, older ? await getProjectVersions(id, undefined, signal) : []);
    });
    for (const entry of candidates) {
      const id = idFromFileName(entry.name)!;
      const job = wanted.get(id)!;
      const version = entry.name === job.name
        ? job.item.version
        : published.get(id)?.find((v) => v.files.some((file) => fileNameWithId(file.filename, id) === entry.name));
      if (version) add(id, { ...entry, version });
    }
  }
  return index;
}

/** Include installed requirements too, even when an update removes that edge. */
async function folderGroups(jobs: Job[], index: Map<string, Existing[]>, signal: AbortSignal) {
  const versionIds = [...new Set([...index.values()].flatMap((entries) => entries.flatMap((entry) =>
    entry.version.dependencies.filter((d) => d.dependency_type === "required" && !d.project_id && d.version_id)
      .map((d) => d.version_id!),
  )))];
  const exact = new Map((await getVersions(versionIds, signal)).map((version) => [version.id, version.project_id]));
  const neighbors = new Map(jobs.map((job) => [job.item.id, new Set<string>()]));
  for (const job of jobs) {
    const dependencies = new Set(job.item.deps);
    for (const entry of index.get(job.item.id) ?? []) {
      for (const dep of entry.version.dependencies) {
        if (dep.dependency_type !== "required") continue;
        const owner = dep.project_id ?? (dep.version_id && exact.get(dep.version_id));
        if (!owner) throw new Error(`Couldn't identify an installed dependency of ${job.item.project?.title ?? job.item.id}.`);
        dependencies.add(owner);
      }
    }
    for (const dep of dependencies) {
      if (!neighbors.has(dep)) continue;
      neighbors.get(job.item.id)!.add(dep);
      neighbors.get(dep)!.add(job.item.id);
    }
  }
  const byId = new Map(jobs.map((job) => [job.item.id, job]));
  const groups: Job[][] = [];
  const remaining = new Set(byId.keys());
  while (remaining.size) {
    const pending = [remaining.values().next().value!];
    const group: Job[] = [];
    while (pending.length) {
      const id = pending.pop()!;
      if (!remaining.delete(id)) continue;
      group.push(byId.get(id)!);
      pending.push(...neighbors.get(id)!);
    }
    groups.push(dependencyOrder(group));
  }
  return groups;
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (e) {
    // Release the writer's lock before attempting rollback.
    await writable.abort().catch(() => {});
    throw e;
  }
}

const missing = (e: unknown) => e instanceof DOMException && e.name === "NotFoundError";

/**
 * Install into a game folder that holds mods/, resourcepacks/ and shaderpacks/
 * (or, with `modsOnly`, straight into a mods folder). Each dependency group
 * is fully staged before changing files. Commit failures restore the group;
 * originals remain in a recovery directory if disk errors prevent rollback.
 */
export async function installToFolder(
  root: FileSystemDirectoryHandle,
  jobs: Job[],
  { replace, modsOnly = false, signal }: { replace: boolean; modsOnly?: boolean; signal: AbortSignal },
  events: InstallEvents,
) {
  events.onStage?.("scanning");
  for (const job of jobs) events.onState(job.item.id, "waiting");
  if (signal.aborted) {
    for (const job of jobs) events.onState(job.item.id, "stopped");
    return;
  }
  let index: Map<string, Existing[]>;
  let groups: Job[][];
  try {
    index = await indexFolder(root, modsOnly, jobs, signal);
    groups = await folderGroups(jobs, index, signal);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    for (const job of jobs) events.onState(job.item.id, signal.aborted ? "stopped" : "failed", reason);
    throw e;
  }
  events.onStage?.("downloading");

  const dirs = new Map<Folder, Promise<FileSystemDirectoryHandle>>();
  const dir = (folder: Folder) => {
    if (modsOnly) return Promise.resolve(root);
    if (!dirs.has(folder)) dirs.set(folder, root.getDirectoryHandle(folder, { create: true }));
    return dirs.get(folder)!;
  };
  const intact = async (data: File, file: Job["item"]["file"]) => {
    if (data.size !== file.size) return false;
    const expected = file.hashes.sha1 ?? file.hashes.sha512;
    if (!expected) return true;
    return (await digest(file.hashes.sha1 ? "SHA-1" : "SHA-512", await data.arrayBuffer())) === expected;
  };

  interface Staged {
    outcome: Outcome;
    data?: Blob;
    remove: Existing[];
    error?: string;
  }
  const staged = new Map<string, Staged>();
  await pool(jobs, 4, async (job) => {
    try {
      signal.throwIfAborted();
      const { folder, id, file, version } = job.item;
      const previous = index.get(id) ?? [];
      const candidate = previous.find((p) => p.folder === folder && (p.name === job.name || p.version.id === version.id));
      const current = candidate && (await intact(candidate.file, file)) ? candidate : undefined;
      if (current) {
        events.onBytes(id, file.size);
        staged.set(id, { outcome: "current", remove: replace ? previous.filter((p) => p !== current) : [] });
        return;
      }
      if (previous.length && !replace) {
        events.onBytes(id, file.size);
        staged.set(id, { outcome: "kept", remove: [] });
        return;
      }

      events.onState(id, "downloading");
      const data = await fetchVerified(job, events, signal);
      staged.set(id, {
        outcome: previous.length ? "updated" : "added", data: new Blob([data]),
        remove: previous.filter((p) => !(p.folder === folder && p.name === job.name)),
      });
    } catch (e) {
      staged.set(job.item.id, { outcome: signal.aborted || isAbort(e) ? "stopped" : "failed", remove: [],
        error: e instanceof Error ? e.message : String(e) });
    }
  });

  events.onStage?.("installing");
  for (const group of groups) {
    const failure = group.find((job) => ["failed", "stopped"].includes(staged.get(job.item.id)!.outcome));
    if (failure || signal.aborted) {
      for (const job of group) events.onState(job.item.id, signal.aborted ? "stopped" : "failed",
        failure ? `${byTitle(jobs, failure.item.id)}: ${staged.get(failure.item.id)!.error}` : undefined);
      for (const job of group) staged.delete(job.item.id);
      continue;
    }

    const paths = new Map<string, { folder: Folder; name: string; original: File | null }>();
    const remember = (folder: Folder, name: string) => paths.set(`${folder}/${name}`, { folder, name, original: null });
    for (const job of group) {
      const pending = staged.get(job.item.id)!;
      if (pending.data) remember(job.item.folder, job.name);
      for (const old of pending.remove) remember(old.folder, old.name);
    }
    const backupName = `.modrinth-backup-${crypto.randomUUID()}`;
    let backedUp = false;
    const changed = new Set<string>();
    let backupCreated = false;
    let backup: FileSystemDirectoryHandle | undefined;
    try {
      for (const path of paths.values()) {
        try {
          const source = modsOnly ? root : await root.getDirectoryHandle(path.folder);
          path.original = await (await source.getFileHandle(path.name)).getFile();
        } catch (e) {
          if (!missing(e)) throw e;
        }
      }
      if (paths.size) {
        backup = await root.getDirectoryHandle(backupName, { create: true });
        backupCreated = true;
        const manifest: Record<string, string | null> = {};
        for (const [key, path] of paths) {
          const relative = modsOnly ? path.name : key;
          manifest[relative] = path.original ? relative : null;
          if (path.original) {
            const target = modsOnly ? backup : await backup.getDirectoryHandle(path.folder, { create: true });
            await writeFile(target, path.name, path.original);
          }
        }
        await writeFile(backup, "original-paths.json", new Blob([JSON.stringify(manifest, null, 2)]));
        backedUp = true;
      }
      signal.throwIfAborted();
      for (const job of group) {
        const pending = staged.get(job.item.id)!;
        if (pending.data) {
          const target = await dir(job.item.folder);
          changed.add(`${job.item.folder}/${job.name}`);
          await writeFile(target, job.name, pending.data);
          signal.throwIfAborted();
        }
      }
      // All replacement files are installed before any older copy is removed.
      for (const job of group) {
        for (const old of staged.get(job.item.id)!.remove) {
          const target = await dir(old.folder);
          changed.add(`${old.folder}/${old.name}`);
          await target.removeEntry(old.name);
          signal.throwIfAborted();
        }
      }
      for (const job of group) events.onState(job.item.id, staged.get(job.item.id)!.outcome);
    } catch (e) {
      const rollbackErrors: string[] = [];
      if (changed.size && backedUp) {
        for (const [key, path] of paths) {
          if (!changed.has(key)) continue;
          try {
            if (path.original) {
              // getFile() snapshots can become unreadable once the source is
              // changed. Restore from the durable backup, not the old File.
              const source = modsOnly ? backup! : await backup!.getDirectoryHandle(path.folder);
              const original = await (await source.getFileHandle(path.name)).getFile();
              await writeFile(await dir(path.folder), path.name, original);
            } else {
              try { await (await dir(path.folder)).removeEntry(path.name); }
              catch (removeError) { if (!missing(removeError)) throw removeError; }
            }
          } catch {
            rollbackErrors.push(key);
          }
        }
      }
      const reason = e instanceof Error ? e.message : String(e);
      const error = rollbackErrors.length
        ? `${reason}. Rollback incomplete for ${rollbackErrors.join(", ")}. Originals retained in ${root.name}/${backupName}; see original-paths.json.`
        : changed.size ? `Installation rolled back: ${reason}` : reason;
      for (const job of group) events.onState(job.item.id,
        signal.aborted && !rollbackErrors.length ? "stopped" : "failed", error);
      // Keep the on-disk originals when rollback could not restore all paths.
      if (rollbackErrors.length) {
        backupCreated = false;
        events.onRecovery?.(`${root.name}/${backupName}`);
      }
    } finally {
      if (backupCreated) {
        try { await root.removeEntry(backupName, { recursive: true }); }
        catch { /* A leftover backup is safe; never remove originals to tidy it. */ }
      }
      for (const job of group) staged.delete(job.item.id);
    }
  }
}

/**
 * Download everything into one zip laid out like a game folder. Each file is
 * handed to a Blob as soon as it arrives, which browsers can keep outside the
 * page's memory, so large collections don't exhaust the tab.
 */
export async function installToZip(jobs: Job[], events: InstallEvents, signal: AbortSignal) {
  const entries: ZipEntry[] = [];
  events.onStage?.("downloading");
  await run(jobs, events, signal, async (job) => {
    events.onState(job.item.id, "downloading");
    const data = await fetchVerified(job, events, signal);
    entries.push({
      path: `${job.item.folder}/${job.name}`,
      crc: crc32(data),
      size: data.length,
      data: new Blob([data]),
    });
    return "added";
  });
  if (signal.aborted || !entries.length) return null;
  events.onStage?.("packing");
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return zip(entries);
}

/** Whether a set of jobs fits in a plain (non-Zip64) archive. */
export function fitsInZip(jobs: Job[]) {
  return jobs.reduce((n, j) => n + j.item.file.size, 0) < ZIP_LIMIT && jobs.length < 65535;
}
