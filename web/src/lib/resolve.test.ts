import { describe, expect, it } from "vitest";
import {
  buildPlan,
  coverage,
  fileNameWithId,
  idFromFileName,
  installSet,
  loadersIn,
  selectVersion,
  type PlanApi,
} from "./resolve";
import type { Dependency, Project, Version } from "./types";

const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id,
  slug: id.toLowerCase(),
  title: id,
  description: "",
  icon_url: null,
  color: null,
  project_type: "mod",
  game_versions: ["26.2"],
  loaders: ["fabric"],
  ...extra,
});

const version = (
  projectId: string,
  extra: Partial<Version> = {},
  deps: Partial<Dependency>[] = [],
): Version => ({
  id: `${projectId}-v`,
  project_id: projectId,
  version_number: "1.0.0",
  version_type: "release",
  game_versions: ["26.2"],
  loaders: ["fabric"],
  files: [
    { url: `https://cdn/${projectId}.jar`, filename: `${projectId}-1.0.0.jar`, primary: true, size: 10, hashes: {} },
  ],
  dependencies: deps.map((d) => ({
    project_id: null,
    version_id: null,
    dependency_type: "required",
    ...d,
  })),
  ...extra,
});

describe("file names", () => {
  it("matches the CLI naming so both tools see the same files", () => {
    expect(fileNameWithId("sodium-fabric-0.9.2+mc26.2.jar", "AANobbMI")).toBe(
      "sodium-fabric-0.9.2+mc26.2.AANobbMI.jar",
    );
    expect(idFromFileName("sodium-fabric-0.9.2+mc26.2.AANobbMI.jar")).toBe("AANobbMI");
    expect(idFromFileName("noextension")).toBeNull();
  });
});

describe("selectVersion", () => {
  const versions = [
    version("a", { id: "alpha", version_type: "alpha" }),
    version("a", { id: "beta", version_type: "beta" }),
    version("a", { id: "old-release", version_type: "release" }),
  ];

  it("prefers a release over newer prereleases", () => {
    expect(selectVersion(versions, "26.2", "fabric", "mod", "alpha")?.id).toBe("old-release");
  });

  it("falls back only as far as the channel allows", () => {
    const pre = versions.slice(0, 2);
    expect(selectVersion(pre, "26.2", "fabric", "mod", "release")).toBeNull();
    expect(selectVersion(pre, "26.2", "fabric", "mod", "beta")?.id).toBe("beta");
    expect(selectVersion(pre.slice(0, 1), "26.2", "fabric", "mod", "alpha")?.id).toBe("alpha");
  });

  it("treats resource packs as loader-independent", () => {
    const pack = [version("p", { loaders: ["minecraft"] })];
    expect(selectVersion(pack, "26.2", "fabric", "mod")).toBeNull();
    expect(selectVersion(pack, "26.2", "fabric", "resourcepack")?.id).toBe("p-v");
  });
});

describe("coverage and loaders", () => {
  const projects = [
    project("a", { game_versions: ["26.1", "26.2"] }),
    project("b", { loaders: ["fabric", "neoforge"] }),
    project("c", { project_type: "resourcepack", loaders: ["minecraft"] }),
    project("d", { project_type: "modpack" }),
  ];

  it("counts projects per game version for a loader", () => {
    const counts = coverage(projects, "fabric");
    expect(counts.get("26.2")).toBe(3);
    expect(counts.get("26.1")).toBe(1);
    expect(coverage(projects, "neoforge").get("26.2")).toBe(2);
  });

  it("lists mod loaders, most common first", () => {
    expect(loadersIn(projects)).toEqual(["fabric", "neoforge"]);
  });
});

function fakeApi(projects: Project[], versions: Record<string, Version[]>): PlanApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getProjects(ids) {
      calls.push(`projects:${ids.join(",")}`);
      return projects.filter((p) => ids.includes(p.id));
    },
    async getProjectVersions(id) {
      calls.push(`versions:${id}`);
      return versions[id] ?? [];
    },
    async getVersions(ids) {
      return Object.values(versions).flat().filter((v) => ids.includes(v.id));
    },
    async pool(items, _limit, fn) {
      for (const item of items) await fn(item);
    },
  };
}

describe("buildPlan", () => {
  const opts = { gameVersion: "26.2", loader: "fabric", channel: "release" as const };

  it("pulls in required dependencies once, recording every parent", async () => {
    const api = fakeApi(
      [project("sodium"), project("litematica"), project("malilib"), project("fapi"), project("pack", { project_type: "modpack" })],
      {
        sodium: [version("sodium", {}, [{ project_id: "fapi" }, { project_id: "opt", dependency_type: "optional" }])],
        litematica: [version("litematica", {}, [{ project_id: "malilib" }, { project_id: "fapi" }])],
        malilib: [version("malilib", {}, [{ project_id: "fapi" }])],
        fapi: [version("fapi")],
      },
    );
    const plan = await buildPlan(api, ["sodium", "litematica", "pack", "gone"], new Map(), opts);

    expect(plan.get("fapi")).toMatchObject({ role: "dependency", folder: "mods", problem: null });
    expect(plan.get("fapi")!.requiredBy.sort()).toEqual(["litematica", "malilib", "sodium"]);
    expect(plan.has("opt")).toBe(false);
    expect(plan.get("pack")!.problem).toBe("unsupported");
    expect(plan.get("gone")!.problem).toBe("unavailable");
    expect(api.calls.filter((c) => c === "versions:fapi")).toHaveLength(1);
  });

  it("resolves dependencies that only name a version", async () => {
    const api = fakeApi([project("a"), project("lib")], {
      a: [version("a", {}, [{ version_id: "lib-v" }])],
      lib: [version("lib")],
    });
    const plan = await buildPlan(api, ["a"], new Map(), opts);
    expect(plan.get("a")!.deps).toEqual(["lib"]);
    expect(plan.get("lib")!.role).toBe("dependency");
  });

  it("files resource packs and shaders into their own folders", async () => {
    const api = fakeApi(
      [project("rp", { project_type: "resourcepack" }), project("sh", { project_type: "shader" })],
      {
        rp: [version("rp", { loaders: ["minecraft"] })],
        sh: [version("sh", { loaders: ["iris"] })],
      },
    );
    const plan = await buildPlan(api, ["rp", "sh"], new Map(), opts);
    expect(plan.get("rp")!.folder).toBe("resourcepacks");
    expect(plan.get("sh")!.folder).toBe("shaderpacks");
  });

  it("drops dependencies only needed by skipped mods", async () => {
    const api = fakeApi([project("a"), project("b"), project("libA"), project("shared")], {
      a: [version("a", {}, [{ project_id: "libA" }, { project_id: "shared" }])],
      b: [version("b", {}, [{ project_id: "shared" }])],
      libA: [version("libA")],
      shared: [version("shared")],
    });
    const plan = await buildPlan(api, ["a", "b"], new Map(), opts);
    expect([...installSet(plan, ["a", "b"], new Set(["a"]))].sort()).toEqual(["b", "shared"]);
    expect([...installSet(plan, ["a", "b"], new Set(["shared"]))].sort()).toEqual(["a", "b", "libA"]);
  });
});

describe("prerelease hints", () => {
  it("notes when a beta would have matched", async () => {
    const api = fakeApi([project("a")], { a: [version("a", { version_type: "beta" })] });
    const plan = await buildPlan(api, ["a"], new Map(), { gameVersion: "26.2", loader: "fabric", channel: "release" });
    expect(plan.get("a")).toMatchObject({ problem: "no-version", fallback: "beta" });
  });
});

describe("exact version pins", () => {
  const opts = { gameVersion: "26.2", loader: "fabric", channel: "release" as const };

  it("uses the pinned version instead of the newest", async () => {
    const api = fakeApi([project("a"), project("lib")], {
      a: [version("a", {}, [{ project_id: "lib", version_id: "lib-old" }])],
      lib: [version("lib", { id: "lib-new" }), version("lib", { id: "lib-old" })],
    });
    const plan = await buildPlan(api, ["a"], new Map(), opts);
    expect(plan.get("lib")!.version!.id).toBe("lib-old");
    expect(plan.get("a")!.problem).toBeNull();
  });

  it("refuses a pin for another game version, and the mod that needs it", async () => {
    const api = fakeApi([project("a"), project("lib")], {
      a: [version("a", {}, [{ project_id: "lib", version_id: "lib-old" }])],
      lib: [version("lib", { id: "lib-old", game_versions: ["26.1"] })],
    });
    const plan = await buildPlan(api, ["a"], new Map(), opts);
    expect(plan.get("lib")!.problem).toBe("pin-incompatible");
    expect(plan.get("a")).toMatchObject({ problem: "missing-dependency", blockedBy: ["lib"] });
  });

  it("offers betas when a pin is only a beta", async () => {
    const api = fakeApi([project("a"), project("lib")], {
      a: [version("a", {}, [{ version_id: "lib-beta" }])],
      lib: [version("lib", { id: "lib-beta", version_type: "beta" })],
    });
    const strict = await buildPlan(api, ["a"], new Map(), opts);
    expect(strict.get("lib")).toMatchObject({ problem: "pin-incompatible", fallback: "beta" });
    const relaxed = await buildPlan(api, ["a"], new Map(), { ...opts, channel: "beta" });
    expect(relaxed.get("lib")!.version!.id).toBe("lib-beta");
  });

  it("marks conflicting pins, and blocks both mods", async () => {
    const api = fakeApi([project("a"), project("b"), project("lib")], {
      a: [version("a", {}, [{ project_id: "lib", version_id: "lib-1" }])],
      b: [version("b", {}, [{ project_id: "lib", version_id: "lib-2" }])],
      lib: [version("lib", { id: "lib-2" }), version("lib", { id: "lib-1" })],
    });
    const plan = await buildPlan(api, ["a", "b"], new Map(), opts);
    expect(plan.get("lib")!.problem).toBe("conflict");
    expect(plan.get("a")!.problem).toBe("missing-dependency");
    expect(plan.get("b")!.problem).toBe("missing-dependency");
  });
});

describe("missing dependencies", () => {
  it("blocks every mod up the chain, but not unrelated ones", async () => {
    const api = fakeApi([project("a"), project("b"), project("c"), project("d")], {
      a: [version("a", {}, [{ project_id: "b" }])],
      b: [version("b", {}, [{ project_id: "c" }])],
      c: [],
      d: [version("d")],
    });
    const plan = await buildPlan(api, ["a", "d"], new Map(), { gameVersion: "26.2", loader: "fabric", channel: "release" });
    expect(plan.get("c")!.problem).toBe("no-version");
    expect(plan.get("b")).toMatchObject({ problem: "missing-dependency", blockedBy: ["c"] });
    expect(plan.get("a")).toMatchObject({ problem: "missing-dependency", blockedBy: ["b"] });
    expect(plan.get("d")!.problem).toBeNull();
  });
});
