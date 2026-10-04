import { describe, expect, it } from "vitest";
import type { GameVersionTag, Project } from "./types";
import { bestVersion, pickTarget, versionChoices } from "./versions";

const tag = (version: string, version_type: GameVersionTag["version_type"] = "release"): GameVersionTag => ({
  version,
  version_type,
  major: false,
});
const TAGS = [tag("26.3"), tag("26.3-pre-1", "snapshot"), tag("26.2"), tag("26.1"), tag("1.21.1"), tag("1.20.1")];

const project = (id: string, game_versions: string[], loaders = ["fabric"], project_type = "mod"): Project => ({
  id,
  slug: id,
  title: id,
  description: "",
  icon_url: null,
  color: null,
  project_type,
  game_versions,
  loaders,
});

describe("bestVersion", () => {
  it("picks the newest release with the widest support", () => {
    const counts = new Map([["26.3", 2], ["26.2", 3], ["26.1", 3], ["26.3-pre-1", 5]]);
    expect(bestVersion(counts, TAGS)).toBe("26.2");
  });
});

describe("versionChoices", () => {
  it("offers the best-supported releases first, newest first, and hides snapshots", () => {
    const counts = new Map([["26.3", 1], ["26.3-pre-1", 4], ["26.2", 4], ["26.1", 3], ["1.21.1", 4], ["1.20.1", 2]]);
    expect(versionChoices(counts, TAGS, 3)).toEqual({ chips: ["26.2", "26.1", "1.21.1"], others: ["26.3", "1.20.1"] });
  });
});

describe("pickTarget", () => {
  const projects = [project("a", ["26.2", "26.1"], ["fabric", "neoforge"]), project("b", ["26.1"], ["neoforge"])];

  it("keeps a supported choice from a shared link", () => {
    expect(pickTarget(projects, { gameVersion: "26.2", loader: "fabric" }, TAGS)).toEqual({
      gameVersion: "26.2",
      loader: "fabric",
    });
  });

  it("falls back to the most common loader and best version", () => {
    expect(pickTarget(projects, { gameVersion: "1.12", loader: "forge" }, TAGS)).toEqual({
      gameVersion: "26.1",
      loader: "neoforge",
    });
  });
});
