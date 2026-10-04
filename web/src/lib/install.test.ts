import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dependencyOrder, installToFolder, installToZip, jobsFor, type InstallEvents, type JobState } from "./install";
import type { Folder, PlanItem } from "./resolve";

// A minimal in-memory stand-in for the File System Access API.
class FakeFile {
  readonly kind = "file";
  readonly name: string;
  data: Uint8Array;
  constructor(name: string, data: Uint8Array) {
    this.name = name;
    this.data = data;
  }
  async getFile() {
    return new File([this.data as Uint8Array<ArrayBuffer>], this.name);
  }
  async createWritable() {
    const chunks: Uint8Array[] = [];
    return {
      write: async (d: Uint8Array) => void chunks.push(d),
      close: async () => {
        this.data = new Uint8Array(Buffer.concat(chunks));
      },
    };
  }
}

class FakeDir {
  readonly kind = "directory";
  files = new Map<string, FakeFile>();
  dirs = new Map<string, FakeDir>();
  readonly name: string;
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
  async removeEntry(name: string) {
    this.files.delete(name);
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
let knownHashes: Record<string, { id: string; project_id: string }> = {};
const flaked = new Set<string>();

beforeEach(() => {
  knownHashes = {};
  flaked.clear();
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v2/version_files")) {
      const { hashes } = JSON.parse(init!.body as string) as { hashes: string[] };
      return Response.json(Object.fromEntries(hashes.filter((h) => knownHashes[h]).map((h) => [h, knownHashes[h]])));
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
afterEach(() => vi.unstubAllGlobals());

function recorder() {
  const states: Record<string, JobState> = {};
  const events: InstallEvents = { onState: (id, s) => void (states[id] = s), onBytes() {} };
  return { states, events };
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
    const states = await run(root, [item("AAAAAAAA", "a-2.0.jar", "A2")], false);
    expect(states.AAAAAAAA).toBe("kept");
    expect(mods.list()).toEqual(["a-1.0.AAAAAAAA.jar"]);
  });

  it("keeps the old version when a download fails its checksum", async () => {
    const root = new FakeDir(".minecraft");
    const mods = await root.getDirectoryHandle("mods", { create: true });
    mods.put("a-1.0.AAAAAAAA.jar", "A1");
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
