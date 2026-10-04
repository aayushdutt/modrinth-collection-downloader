import { getVersionsByHash, pool } from "./modrinth";
import { fileNameWithId, idFromFileName, type Folder, type PlanItem } from "./resolve";
import { crc32, zip, ZIP_LIMIT, type ZipEntry } from "./zip";

export type Outcome = "added" | "updated" | "current" | "kept" | "failed" | "stopped";
export type JobState = "waiting" | "downloading" | Outcome;
export type Stage = "scanning" | "downloading" | "packing";
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
  /** Set when the file was identified by its hash rather than its name. */
  versionId?: string;
}

/**
 * Find what's already installed for each project. Files this tool (or the
 * CLI) wrote carry the project id in their name; anything else is identified
 * by asking Modrinth about its SHA-1, so hand-installed copies aren't
 * duplicated (two copies of a mod stop the game from starting).
 */
async function indexFolder(
  root: FileSystemDirectoryHandle,
  modsOnly: boolean,
  wanted: Set<string>,
  signal: AbortSignal,
) {
  const index = new Map<string, Existing[]>();
  const add = (id: string, entry: Existing) => index.set(id, [...(index.get(id) ?? []), entry]);
  const unknown: { folder: Folder; handle: FileSystemFileHandle }[] = [];

  for (const folder of modsOnly ? (["mods"] as Folder[]) : FOLDERS) {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = modsOnly ? root : await root.getDirectoryHandle(folder);
    } catch {
      continue;
    }
    for await (const handle of dir.values()) {
      if (handle.kind !== "file") continue;
      const id = idFromFileName(handle.name);
      if (id && wanted.has(id)) add(id, { folder, name: handle.name });
      else if (/\.(jar|zip)$/i.test(handle.name)) unknown.push({ folder, handle: handle as FileSystemFileHandle });
    }
  }

  if (unknown.length) {
    const hashes = new Map<string, Existing>();
    await pool(unknown, 4, async ({ folder, handle }) => {
      if (signal.aborted) return;
      const file = await handle.getFile();
      if (file.size > 512 * 1024 * 1024) return;
      hashes.set(await digest("SHA-1", await file.arrayBuffer()), { folder, name: handle.name });
    });
    signal.throwIfAborted();
    try {
      const found = await getVersionsByHash([...hashes.keys()], signal);
      for (const [hash, version] of Object.entries(found)) {
        const entry = hashes.get(hash);
        if (entry && wanted.has(version.project_id)) add(version.project_id, { ...entry, versionId: version.id });
      }
    } catch (e) {
      if (signal.aborted) throw e;
      // Without the lookup, files named the usual way are still handled.
    }
  }
  return index;
}

/**
 * Install into a game folder that holds mods/, resourcepacks/ and shaderpacks/
 * (or, with `modsOnly`, straight into a mods folder). Files already at the
 * planned version are left alone; older versions are replaced, or kept when
 * `replace` is off.
 */
export async function installToFolder(
  root: FileSystemDirectoryHandle,
  jobs: Job[],
  { replace, modsOnly = false, signal }: { replace: boolean; modsOnly?: boolean; signal: AbortSignal },
  events: InstallEvents,
) {
  events.onStage?.("scanning");
  const index = await indexFolder(root, modsOnly, new Set(jobs.map((j) => j.item.id)), signal);
  events.onStage?.("downloading");

  const dirs = new Map<Folder, Promise<FileSystemDirectoryHandle>>();
  const dir = (folder: Folder) => {
    if (modsOnly) return Promise.resolve(root);
    if (!dirs.has(folder)) dirs.set(folder, root.getDirectoryHandle(folder, { create: true }));
    return dirs.get(folder)!;
  };
  const remove = async (entries: Existing[]) => {
    for (const old of entries) await (await dir(old.folder)).removeEntry(old.name);
  };

  /** Whether a file on disk really is the planned file, not just named like it. */
  const intact = async (entry: Existing, file: Job["item"]["file"]) => {
    if (entry.versionId) return true; // Identified by its hash already.
    const data = await (await (await dir(entry.folder)).getFileHandle(entry.name)).getFile();
    if (data.size !== file.size) return false;
    const expected = file.hashes.sha1 ?? file.hashes.sha512;
    if (!expected) return true;
    return (await digest(file.hashes.sha1 ? "SHA-1" : "SHA-512", await data.arrayBuffer())) === expected;
  };

  await run(jobs, events, signal, async (job) => {
    const { folder, id, file, version } = job.item;
    const previous = index.get(id) ?? [];
    const candidate = previous.find((p) => p.folder === folder && (p.name === job.name || p.versionId === version.id));
    const current = candidate && (await intact(candidate, file)) ? candidate : undefined;
    if (current) {
      // Tidy up stray older copies sitting next to the current one.
      if (replace) await remove(previous.filter((p) => p !== current));
      events.onBytes(id, file.size);
      return "current";
    }
    if (previous.length && !replace) {
      events.onBytes(id, file.size);
      return "kept";
    }

    events.onState(id, "downloading");
    const data = await fetchVerified(job, events, signal);
    signal.throwIfAborted(); // Don't change the folder after Stop.
    const handle = await (await dir(folder)).getFileHandle(job.name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();

    // Only remove old versions once the new one is safely on disk. A damaged
    // copy with the same name was just overwritten, so it isn't removed.
    await remove(previous.filter((p) => !(p.folder === folder && p.name === job.name)));
    return previous.length ? "updated" : "added";
  });
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
