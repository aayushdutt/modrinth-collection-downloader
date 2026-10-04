import { describe, expect, it } from "vitest";
import { jobsFor, type ItemProgress } from "./install";
import type { PlanItem } from "./resolve";
import { installResult, planSummary } from "./summary";

function item(id: string, extra: Partial<PlanItem> = {}): PlanItem {
  return {
    id,
    project: { id, slug: id, title: id.toUpperCase(), description: "", icon_url: null, color: null, project_type: "mod", game_versions: [], loaders: [] },
    kind: "mod",
    role: "collection",
    requiredBy: [],
    version: {
      id: `${id}-v`,
      project_id: id,
      version_number: "1",
      version_type: "release",
      game_versions: ["26.2"],
      loaders: ["fabric"],
      files: [],
      dependencies: [],
    },
    file: { url: "", filename: `${id}.jar`, primary: true, size: 1024 * 1024, hashes: {} },
    folder: "mods",
    problem: null,
    fallback: null,
    pinned: null,
    blockedBy: [],
    deps: [],
    ...extra,
  };
}

const missing = (id: string, extra: Partial<PlanItem> = {}) =>
  item(id, { version: null, file: null, problem: "no-version", ...extra });

const ctx = { gameVersion: "26.2", loader: "fabric", nameOf: (id: string) => id.toUpperCase() };

describe("planSummary", () => {
  it("leads with what's ready", () => {
    const items = [item("a"), item("b")];
    expect(planSummary(items, jobsFor(items), new Set(), ctx)).toEqual([{ text: "2 files ready (2.0 MB)." }]);
  });

  it("names a few missing projects and offers betas when they exist", () => {
    const items = [item("a"), missing("b", { fallback: "beta" })];
    expect(planSummary(items, jobsFor(items), new Set(), ctx).slice(1)).toEqual([
      { text: "Not available for 26.2 Fabric: B." },
      { text: "It has a beta.", action: "use-betas" },
    ]);
  });

  it("counts many missing projects and offers to show them", () => {
    const items = ["a", "b", "c", "d"].map((id) => missing(id));
    expect(planSummary(items, [], new Set(), ctx)).toEqual([
      { text: "Nothing available for this version." },
      { text: "4 aren't available for 26.2 Fabric.", action: "show-problems" },
    ]);
  });

  it("names mods left out for a missing dependency", () => {
    const items = [item("a", { problem: "missing-dependency", blockedBy: ["lib"], deps: ["lib"] }), missing("lib")];
    expect(planSummary(items, [], new Set(), ctx).slice(1)).toEqual([
      { text: "Not available for 26.2 Fabric: LIB." },
      { text: "Left out because a dependency isn't available: A." },
    ]);
  });

  it("warns when a skipped project is needed by another", () => {
    const items = [item("a", { deps: ["lib"] })];
    expect(planSummary(items, jobsFor(items), new Set(["lib"]), ctx).at(-1)).toEqual({
      text: "You skipped LIB, which other mods need.",
    });
  });
});

describe("installResult", () => {
  const progress = (...states: ItemProgress["state"][]) =>
    Object.fromEntries(states.map((state, i) => [String(i), { state, bytes: 0 }]));

  it("summarises a folder install", () => {
    expect(installResult({ target: "folder", stopped: false, savedAs: null, progress: progress("added", "added", "current") })).toBe(
      "Installed 2 and 1 already up to date.",
    );
  });

  it("reports a stop", () => {
    expect(installResult({ target: "folder", stopped: true, savedAs: null, progress: progress("added", "stopped") })).toBe(
      "Stopped after installing 1.",
    );
    expect(installResult({ target: "zip", stopped: true, savedAs: null, progress: {} })).toBe("Stopped. Nothing saved.");
  });
});
