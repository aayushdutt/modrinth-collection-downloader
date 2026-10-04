import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dependencyOrder, installToFolder, installToZip, jobsFor, type InstallEvents, type JobState } from "./install";
import * as modrinth from "./modrinth";
import type { Folder, PlanItem } from "./resolve";
import type { Version } from "./types";

// A minimal in-memory stand-in for the File System Access API.
class FakeFile {
  readonly kind = "file";
  readonly name: string;
  data: Uint8Array;
  writeFailures = 0;
  closeFailures = 0;
  onClose?: () => void;
  constructor(name: string, data: Uint8Array) {
    this.name = name;
    this.data = data;
  }
  async getFile() {
    const snapshot = this.data;
    const file = new File([snapshot as Uint8Array<ArrayBuffer>], this.name);
    const read = file.arrayBuffer.bind(file);
    file.arrayBuffer = async () => {
      if (snapshot !== this.data) throw new DOMException("snapshot changed", "NotReadableError");
      return read();
    };
    return file;
  }
  async createWritable() {
    const chunks: Uint8Array[] = [];
    return {
      write: async (d: Uint8Array | Blob) => {
        if (this.writeFailures > 0) {
          this.writeFailures--;
          throw new DOMException("disk write failed", "UnknownError");
        }
        chunks.push(d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : d);
      },
      close: async () => {
        if (this.closeFailures > 0) {
          this.closeFailures--;
          throw new DOMException("disk close failed", "UnknownError");
        }
        this.data = new Uint8Array(Buffer.concat(chunks));
        this.onClose?.();
      },
      abort: async () => {},
    };
  }
}

class FakeDir {
  readonly kind = "directory";
  files = new Map<string, FakeFile>();
  dirs = new Map<string, FakeDir>();
  readonly name: string;
  removalFailures = new Set<string>();
  onRemove?: (name: string) => void;
  constructor(name: string) {
    this.name = name;
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    if (!this.dirs.has(name)) {
      if (!opts?.create) throw new DOMException("missing", "NotFoundError");
      this.dirs.set(name, new FakeDir(name));
    }
    return this.dirs.get(name)!;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!opts?.create) throw new DOMException("missing", "NotFoundError");
      this.files.set(name, new FakeFile(name, new Uint8Array()));
    }
    return this.files.get(name)!;
  }
  async removeEntry(name: string, _opts?: { recursive?: boolean }) {
    if (this.removalFailures.delete(name)) throw new DOMException("disk removal failed", "UnknownError");
    if (!this.files.delete(name) && !this.dirs.delete(name)) throw new DOMException("missing", "NotFoundError");
    this.onRemove?.(name);
  }
  async *values() {
    yield* this.dirs.values();
    yield* this.files.values();
  }
  put(name: string, text: string) {
    this.files.set(name, new FakeFile(name, new TextEncoder().encode(text)));
  }
  list() {
    return [...this.files.keys()].sort();
  }
}

const sha = (algo: "sha1" | "sha512", text: string) => createHash(algo).update(text).digest("hex");

/** A plan item whose download serves `content` from a fake CDN. */
function item(id: string, filename: string, content: string, folder: Folder = "mods"): PlanItem {
  return {
    id,
    project: null,
    kind: folder === "resourcepacks" ? "resourcepack" : "mod",
    role: "collection",
    requiredBy: [],
    version: {
      id: `${id}-v2`,
      project_id: id,
      version_number: "2.0",
      version_type: "release",
      game_versions: ["26.2"],
      loaders: ["fabric"],
      files: [],
      dependencies: [],
    },
    file: {
      url: `https://cdn.test/${id}/${content}`,
      filename,
      primary: true,
      size: content.length,
      hashes: { sha512: sha("sha512", content) },
    },
    folder,
    problem: null,
    fallback: null,
    pinned: null,
    blockedBy: [],
    deps: [],
  };
}

/** Hash lookups Modrinth would answer: sha1 of a file's text -> its project and version. */
let knownHashes: Record<string, Partial<Version> & Pick<Version, "id" | "project_id">> = {};
let publishedVersions: Record<string, Version[]> = {};

function publish(id: string, filename: string, content: string, dependencies: Version["dependencies"] = []) {
  const planned = item(id, filename, content);
  const version = { ...planned.version!, id: `${id}-v1`, files: [planned.file!], dependencies };
  knownHashes[sha("sha1", content)] = version;
  (publishedVersions[id] ??= []).push(version);
  return version;
}
const flaked = new Set<string>();

beforeEach(() => {
  knownHashes = {};
  publishedVersions = {};
  flaked.clear();
  vi.spyOn(modrinth, "getProjectVersions").mockImplementation(async (id) => publishedVersions[id] ?? []);
  vi.spyOn(modrinth, "getVersions").mockImplementation(async (ids) =>
    Object.values(publishedVersions).flat().filter((version) => ids.includes(version.id)));
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v2/version_files")) {
      const { hashes } = JSON.parse(init!.body as string) as { hashes: string[] };
      return Response.json(Object.fromEntries(hashes.filter((h) => knownHashes[h]).map((h) =>
        [h, { ...item(knownHashes[h].project_id, "file.jar", "").version, ...knownHashes[h] }])));
    }
    const content = decodeURIComponent(url.split("/").pop()!);
    // "flaky-*" files drop the connection on the first request.
    if (content.startsWith("flaky-") && !flaked.has(content)) {
      flaked.add(content);
      throw new TypeError("network error");
    }
    return new Response(content === "404" ? null : content, { status: content === "404" ? 404 : 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function recorder() {
  const states: Record<string, JobState> = {};
  const errors: Record<string, string | undefined> = {};
  const recovery: string[] = [];
  const events: InstallEvents = {
    onState: (id, s, error) => { states[id] = s; errors[id] = error; }, onBytes() {},
    onRecovery: (directory) => void recovery.push(directory),
  };
  return { states, errors, events, recovery };
}

const run = (root: FakeDir, items: PlanItem[], replace = true) => {
  const { states, events } = recorder();
  const signal = new AbortController().signal;
  return installToFolder(root as unknown as FileSystemDirectoryHandle, jobsFor(items), { replace, signal }, events).then(
    () => states,
  );
};

describe("installToFolder", () => {
  it("adds new files, named so the CLI recognises them, into the right folders", async () => {
    const root = new FakeDir(".minecraft");
    const states = await run(root, [item("AAAAAAAA", "a-2.0.jar", "A2"), item("PPPPPPPP", "pack.zip", "P", "resourcepacks")]);
    expect(states).toEqual({ AAAAAAAA: "added", PPPPPPPP: "added" });
    expect(root.dirs.get("mods")!.list()).toEqual(["a-2.0.AAAAAAAA.jar"]);
    expect(root.dirs.get("resourcepacks")!.list()).toEqual(["pack.PPPPPPPP.zip"]);
  });

  it("replaces older versions and leaves unrelated files alone", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("a-1.0.AAAAAAAA.jar", "A1");
    publish("AAAAAAAA", "a-1.0.jar", "A1");
    mods.put("my-own-mod.jar", "mine");
    const states = await run(root, [item("AAAAAAAA", "a-2.0.jar", "A2")]);
    expect(states.AAAAAAAA).toBe("updated");
    expect(mods.list()).toEqual(["a-2.0.AAAAAAAA.jar", "my-own-mod.jar"]);
  });

  it("recognises hand-installed copies by hash instead of duplicating them", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("a-2.0.jar", "A2"); // the exact planned version, renamed
    mods.put("b-old.jar", "B1"); // an older version of another project
    knownHashes[sha("sha1", "A2")] = { id: "AAAAAAAA-v2", project_id: "AAAAAAAA" };
    knownHashes[sha("sha1", "B1")] = { id: "BBBBBBBB-v1", project_id: "BBBBBBBB" };

    const states = await run(root, [item("AAAAAAAA", "a-2.0.jar", "A2"), item("BBBBBBBB", "b-2.0.jar", "B2")]);
    expect(states).toEqual({ AAAAAAAA: "current", BBBBBBBB: "updated" });
    expect(mods.list()).toEqual(["a-2.0.jar", "b-2.0.BBBBBBBB.jar"]);
  });

  it("keeps existing versions when replacing is off", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("a-1.0.AAAAAAAA.jar", "A1");
    publish("AAAAAAAA", "a-1.0.jar", "A1");
    const states = await run(root, [item("AAAAAAAA", "a-2.0.jar", "A2")], false);
    expect(states.AAAAAAAA).toBe("kept");
    expect(mods.list()).toEqual(["a-1.0.AAAAAAAA.jar"]);
  });

  it("keeps the old version when a download fails its checksum", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("a-1.0.AAAAAAAA.jar", "A1");
    publish("AAAAAAAA", "a-1.0.jar", "A1");
    const bad = item("AAAAAAAA", "a-2.0.jar", "A2");
    bad.file!.hashes.sha512 = sha("sha512", "something else");
    const states = await run(root, [bad]);
    expect(states.AAAAAAAA).toBe("failed");
    expect(mods.list()).toEqual(["a-1.0.AAAAAAAA.jar"]);
  });

  it("replaces a damaged file that only looks current", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("a-2.0.AAAAAAAA.jar", "truncated");
    const states = await run(root, [item("AAAAAAAA", "a-2.0.jar", "A2")]);
    expect(states.AAAAAAAA).toBe("updated");
    expect(mods.list()).toEqual(["a-2.0.AAAAAAAA.jar"]);
    expect(new TextDecoder().decode(mods.files.get("a-2.0.AAAAAAAA.jar")!.data)).toBe("A2");
  });

  it("retries a download that drops", async () => {
    const root = new FakeDir(".minecraft");
    const states = await run(root, [item("AAAAAAAA", "a.jar", "flaky-A")]);
    expect(states.AAAAAAAA).toBe("added");
  });

  it("doesn't install a mod whose dependency failed, and keeps its old version", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("a-1.0.AAAAAAAA.jar", "A1");
    publish("AAAAAAAA", "a-1.0.jar", "A1");
    const parent = { ...item("AAAAAAAA", "a-2.0.jar", "A2"), deps: ["LLLLLLLL"] };
    const states = await run(root, [parent, item("LLLLLLLL", "lib.jar", "404")]);
    expect(states).toEqual({ LLLLLLLL: "failed", AAAAAAAA: "failed" });
    expect(mods.list()).toEqual(["a-1.0.AAAAAAAA.jar"]);
  });

  it("marks everything stopped when cancelled before downloading", async () => {
    const root = new FakeDir(".minecraft");
    const { states, events } = recorder();
    const controller = new AbortController();
    controller.abort();
    const jobs = jobsFor([item("AAAAAAAA", "a.jar", "A"), item("BBBBBBBB", "b.jar", "B")]);
    await installToFolder(root as unknown as FileSystemDirectoryHandle, jobs, { replace: true, signal: controller.signal }, events);
    expect(states).toEqual({ AAAAAAAA: "stopped", BBBBBBBB: "stopped" });
    expect(root.dirs.get("mods")).toBeUndefined();
  });

  it("preserves unrelated files containing a wanted project ID", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("notes.AAAAAAAA.txt", "my notes");
    mods.put("other.AAAAAAAA.jar", "not this project");
    const states = await run(root, [item("AAAAAAAA", "a.jar", "A2")]);
    expect(states.AAAAAAAA).toBe("added");
    expect(mods.list()).toEqual(["a.AAAAAAAA.jar", "notes.AAAAAAAA.txt", "other.AAAAAAAA.jar"]);
  });

  it("repairs a damaged older file only when its complete filename was published", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    publish("AAAAAAAA", "a-old.jar", "A1");
    mods.put("a-old.AAAAAAAA.jar", "corrupt");
    mods.put("a-other.AAAAAAAA.jar", "also corrupt");
    await run(root, [item("AAAAAAAA", "a-new.jar", "A2")]);
    expect(mods.list()).toEqual(["a-new.AAAAAAAA.jar", "a-other.AAAAAAAA.jar"]);
  });

  it("removes all hand-installed duplicates with identical hashes, including misplaced copies", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    const packs = await root.getDirectoryHandle("resourcepacks", { create: true });
    mods.put("a-old.jar", "A1");
    mods.put("a-copy.jar", "A1");
    packs.put("a-misplaced.jar", "A1");
    publish("AAAAAAAA", "a-old.jar", "A1");
    await run(root, [item("AAAAAAAA", "a-new.jar", "A2")]);
    expect(mods.list()).toEqual(["a-new.AAAAAAAA.jar"]);
    expect(packs.list()).toEqual([]);
  });

  it("stops before writing when installed-file identification fails", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("a-old.jar", "A1");
    vi.spyOn(modrinth, "getVersionsByHash").mockRejectedValue(new TypeError("connection lost"));
    await expect(run(root, [item("AAAAAAAA", "a-new.jar", "A2")])).rejects.toThrow("connection lost");
    expect(mods.list()).toEqual(["a-old.jar"]);
  });

  it("preserves a target filename identified as belonging to another project", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("a.AAAAAAAA.jar", "other project");
    publish("BBBBBBBB", "b.jar", "other project");
    await expect(run(root, [item("AAAAAAAA", "a.jar", "A2")])).rejects.toThrow("belongs to another Modrinth project");
    expect(new TextDecoder().decode(mods.files.get("a.AAAAAAAA.jar")!.data)).toBe("other project");
  });

  it("preserves the dependency group when a parent fails, while installing an independent mod", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("parent-old.PPPPPPPP.jar", "P1");
    mods.put("dep-old.DDDDDDDD.jar", "D1");
    publish("PPPPPPPP", "parent-old.jar", "P1");
    publish("DDDDDDDD", "dep-old.jar", "D1");
    const parent = { ...item("PPPPPPPP", "parent-new.jar", "404"), deps: ["DDDDDDDD"] };
    const states = await run(root, [parent, item("DDDDDDDD", "dep-new.jar", "D2"), item("IIIIIIII", "independent.jar", "I")]);
    expect(states).toEqual({ PPPPPPPP: "failed", DDDDDDDD: "failed", IIIIIIII: "added" });
    expect(mods.list()).toEqual(["dep-old.DDDDDDDD.jar", "independent.IIIIIIII.jar", "parent-old.PPPPPPPP.jar"]);
    expect([...root.dirs.keys()]).toEqual(["mods"]);
  });

  it.each(["project", "version"])("preserves installed %s requirements removed by the new parent", async (reference) => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("parent-old.PPPPPPPP.jar", "P1");
    mods.put("dep-old.DDDDDDDD.jar", "D1");
    const dep = publish("DDDDDDDD", "dep-old.jar", "D1");
    publish("PPPPPPPP", "parent-old.jar", "P1", [{ dependency_type: "required",
      project_id: reference === "project" ? "DDDDDDDD" : null,
      version_id: reference === "version" ? dep.id : null }]);
    const states = await run(root, [item("PPPPPPPP", "parent-new.jar", "404"), item("DDDDDDDD", "dep-new.jar", "D2")]);
    expect(states).toEqual({ PPPPPPPP: "failed", DDDDDDDD: "failed" });
    expect(mods.list()).toEqual(["dep-old.DDDDDDDD.jar", "parent-old.PPPPPPPP.jar"]);
  });

  it.each(["writeFailures", "closeFailures"] as const)("restores overwritten files after a %s failure", async (failure) => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("parent.PPPPPPPP.jar", "P1");
    mods.put("dep.DDDDDDDD.jar", "D1");
    publish("PPPPPPPP", "parent.jar", "P1");
    publish("DDDDDDDD", "dep.jar", "D1");
    mods.files.get("parent.PPPPPPPP.jar")![failure] = 1;
    const parent = { ...item("PPPPPPPP", "parent.jar", "P2"), deps: ["DDDDDDDD"] };
    const states = await run(root, [parent, item("DDDDDDDD", "dep.jar", "D2")]);
    expect(states).toEqual({ PPPPPPPP: "failed", DDDDDDDD: "failed" });
    expect(new TextDecoder().decode(mods.files.get("parent.PPPPPPPP.jar")!.data)).toBe("P1");
    expect(new TextDecoder().decode(mods.files.get("dep.DDDDDDDD.jar")!.data)).toBe("D1");
    expect([...root.dirs.keys()]).toEqual(["mods"]);
  });

  it("restores removed old files and removes new files after a cleanup failure", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("parent-old.PPPPPPPP.jar", "P1");
    mods.put("dep-old.DDDDDDDD.jar", "D1");
    publish("PPPPPPPP", "parent-old.jar", "P1");
    publish("DDDDDDDD", "dep-old.jar", "D1");
    mods.removalFailures.add("parent-old.PPPPPPPP.jar");
    const parent = { ...item("PPPPPPPP", "parent-new.jar", "P2"), deps: ["DDDDDDDD"] };
    const states = await run(root, [parent, item("DDDDDDDD", "dep-new.jar", "D2")]);
    expect(states).toEqual({ PPPPPPPP: "failed", DDDDDDDD: "failed" });
    expect(mods.list()).toEqual(["dep-old.DDDDDDDD.jar", "parent-old.PPPPPPPP.jar"]);
    expect(new TextDecoder().decode(mods.files.get("dep-old.DDDDDDDD.jar")!.data)).toBe("D1");
    expect([...root.dirs.keys()]).toEqual(["mods"]);
  });

  it("leaves all originals untouched when Stop interrupts staging", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("a-old.AAAAAAAA.jar", "A1");
    publish("AAAAAAAA", "a-old.jar", "A1");
    const controller = new AbortController();
    const { events, states } = recorder();
    events.onBytes = () => controller.abort();
    await installToFolder(root as unknown as FileSystemDirectoryHandle, jobsFor([item("AAAAAAAA", "a-new.jar", "A2")]),
      { replace: true, signal: controller.signal }, events);
    expect(states.AAAAAAAA).toBe("stopped");
    expect(mods.list()).toEqual(["a-old.AAAAAAAA.jar"]);
  });

  it("rolls back the current group when Stop interrupts a commit", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("parent.PPPPPPPP.jar", "P1");
    mods.put("dep.DDDDDDDD.jar", "D1");
    publish("PPPPPPPP", "parent.jar", "P1");
    publish("DDDDDDDD", "dep.jar", "D1");
    const controller = new AbortController();
    mods.files.get("dep.DDDDDDDD.jar")!.onClose = () => controller.abort();
    const { events, states } = recorder();
    const parent = { ...item("PPPPPPPP", "parent.jar", "P2"), deps: ["DDDDDDDD"] };
    await installToFolder(root as unknown as FileSystemDirectoryHandle, jobsFor([parent, item("DDDDDDDD", "dep.jar", "D2")]),
      { replace: true, signal: controller.signal }, events);
    expect(states).toEqual({ PPPPPPPP: "stopped", DDDDDDDD: "stopped" });
    expect(new TextDecoder().decode(mods.files.get("dep.DDDDDDDD.jar")!.data)).toBe("D1");
    expect(new TextDecoder().decode(mods.files.get("parent.PPPPPPPP.jar")!.data)).toBe("P1");
    expect([...root.dirs.keys()]).toEqual(["mods"]);
  });

  it("retains durable originals and a recovery map when rollback fails", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("parent.PPPPPPPP.jar", "P1");
    mods.put("dep.DDDDDDDD.jar", "D1");
    publish("PPPPPPPP", "parent.jar", "P1");
    publish("DDDDDDDD", "dep.jar", "D1");
    const dep = mods.files.get("dep.DDDDDDDD.jar")!;
    dep.onClose = () => { dep.writeFailures = 1; };
    mods.files.get("parent.PPPPPPPP.jar")!.writeFailures = 1;
    const { events, states, errors, recovery } = recorder();
    const parent = { ...item("PPPPPPPP", "parent.jar", "P2"), deps: ["DDDDDDDD"] };
    await installToFolder(root as unknown as FileSystemDirectoryHandle, jobsFor([parent, item("DDDDDDDD", "dep.jar", "D2")]),
      { replace: true, signal: new AbortController().signal }, events);
    expect(states).toEqual({ PPPPPPPP: "failed", DDDDDDDD: "failed" });
    const backupName = [...root.dirs.keys()].find((name) => name.startsWith(".modrinth-backup-"))!;
    expect(errors.PPPPPPPP).toContain(`Originals retained in .minecraft/${backupName}`);
    expect(recovery).toEqual([`.minecraft/${backupName}`]);
    const backup = root.dirs.get(backupName)!;
    expect(new TextDecoder().decode(backup.dirs.get("mods")!.files.get("dep.DDDDDDDD.jar")!.data)).toBe("D1");
    expect(JSON.parse(new TextDecoder().decode(backup.files.get("original-paths.json")!.data))).toEqual({
      "mods/dep.DDDDDDDD.jar": "mods/dep.DDDDDDDD.jar", "mods/parent.PPPPPPPP.jar": "mods/parent.PPPPPPPP.jar",
    });
  });

  it("writes no targets when creating the recovery backup fails", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("a.AAAAAAAA.jar", "A1");
    publish("AAAAAAAA", "a.jar", "A1");
    const getDir = root.getDirectoryHandle.bind(root);
    vi.spyOn(root, "getDirectoryHandle").mockImplementation(async (name, options) => {
      if (name.startsWith(".modrinth-backup-")) throw new DOMException("backup denied", "NotAllowedError");
      return getDir(name, options);
    });
    const states = await run(root, [item("AAAAAAAA", "a.jar", "A2")]);
    expect(states.AAAAAAAA).toBe("failed");
    expect(new TextDecoder().decode(mods.files.get("a.AAAAAAAA.jar")!.data)).toBe("A1");
  });

  it("installs directly into a mods folder and removes successful backups", async () => {
    const mods = new FakeDir("mods");
    mods.put("a-old.jar", "A1");
    publish("AAAAAAAA", "a-old.jar", "A1");
    const { events, states } = recorder();
    await installToFolder(mods as unknown as FileSystemDirectoryHandle, jobsFor([item("AAAAAAAA", "a-new.jar", "A2")]),
      { replace: true, modsOnly: true, signal: new AbortController().signal }, events);
    expect(states.AAAAAAAA).toBe("updated");
    expect(mods.list()).toEqual(["a-new.AAAAAAAA.jar"]);
    expect([...mods.dirs.keys()]).toEqual([]);
  });
});

describe("installToZip", () => {
  it("packs successful downloads and reports failures", async () => {
    const { states, events } = recorder();
    const blob = await installToZip(
      jobsFor([item("AAAAAAAA", "a.jar", "A"), item("BBBBBBBB", "b.jar", "404")]),
      events,
      new AbortController().signal,
    );
    expect(states).toEqual({ AAAAAAAA: "added", BBBBBBBB: "failed" });
    const text = new TextDecoder().decode(await blob!.arrayBuffer());
    expect(text).toContain("mods/a.AAAAAAAA.jar");
    expect(text).not.toContain("b.BBBBBBBB.jar");
  });
});

describe("dependencyOrder", () => {
  it("puts dependencies first and survives cycles", () => {
    const a = { ...item("A", "a.jar", "a"), deps: ["B"] };
    const b = { ...item("B", "b.jar", "b"), deps: ["C"] };
    const c = { ...item("C", "c.jar", "c"), deps: ["A"] };
    expect(dependencyOrder(jobsFor([a, b, c])).map((j) => j.item.id)).toEqual(["C", "B", "A"]);
  });
});
