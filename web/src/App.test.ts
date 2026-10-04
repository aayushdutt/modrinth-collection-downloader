// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as install from "./lib/install";
import * as modrinth from "./lib/modrinth";
import type { Version } from "./lib/types";

vi.mock("./lib/modrinth", async (original) => ({
  ...await original<typeof modrinth>(),
  getCollection: vi.fn(),
  getProjects: vi.fn(),
  getProjectVersions: vi.fn(),
  getGameVersions: vi.fn(async () => [
    { version: "26.2", version_type: "release", major: true },
    { version: "26.1.2", version_type: "release", major: true },
  ]),
}));
vi.mock("./lib/platform", async (original) => ({
  ...await original<typeof import("./lib/platform")>(), supportsFolderAccess: () => true,
}));
vi.mock("./hooks/useShareUrl", async (original) => ({
  ...await original<typeof import("./hooks/useShareUrl")>(),
  readShareUrl: () => ({ collection: "test", gameVersion: "26.2", loader: "fabric", allowAlpha: false }),
}));

const version = (gameVersion: string): Version => ({
  id: `a-${gameVersion}`, project_id: "a", version_number: gameVersion, version_type: "release",
  game_versions: [gameVersion], loaders: ["fabric"], dependencies: [],
  files: [{ filename: `a-${gameVersion}.jar`, primary: true, size: 100, url: "https://cdn.test/a.jar", hashes: {} }],
});

let root: Root;
let container: HTMLDivElement;
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(modrinth.getCollection).mockResolvedValue({ id: "test", name: "Test", description: null, icon_url: null, projects: ["a"] });
  vi.mocked(modrinth.getProjects).mockResolvedValue([{
    id: "a", title: "A", slug: "a", description: "", icon_url: null, color: null,
    project_type: "mod", game_versions: ["26.2", "26.1.2"], loaders: ["fabric"],
  }]);
  vi.mocked(modrinth.getProjectVersions).mockImplementation(async (_id, target) => [version(target!)]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("install actions use the current plan", () => {
  it("disables both actions during resolution and after failure, and enables them after a successful retry", async () => {
    await act(async () => root.render(createElement(App)));
    expect(button("Download zip").disabled).toBe(false);
    expect(button("Install into folder").disabled).toBe(false);

    let reject!: (error: Error) => void;
    vi.mocked(modrinth.getProjectVersions).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await act(async () => button("26.1.2").click());
    expect(button("Download zip").disabled).toBe(true);
    expect(button("Install into folder").disabled).toBe(true);

    await act(async () => reject(new TypeError("connection lost")));
    expect(container.textContent).toContain("Lost contact with Modrinth");
    expect(button("Download zip").disabled).toBe(true);
    expect(button("Install into folder").disabled).toBe(true);

    await act(async () => button("Try again").click());
    expect(container.textContent).not.toContain("Lost contact with Modrinth");
    expect(button("Download zip").disabled).toBe(false);
    expect(button("Install into folder").disabled).toBe(false);
  });

  it("clears a pending folder confirmation when the target changes", async () => {
    window.showDirectoryPicker = vi.fn().mockResolvedValue({ name: "empty", getDirectoryHandle: async () => {
      throw new DOMException("missing", "NotFoundError");
    } });
    await act(async () => root.render(createElement(App)));
    await act(async () => button("Install into folder").click());
    expect(button("Install here").disabled).toBe(false);

    vi.mocked(modrinth.getProjectVersions).mockRejectedValueOnce(new TypeError("connection lost"));
    await act(async () => button("26.1.2").click());
    expect(button("Install here")).toBeUndefined();
    expect(button("Install into folder").disabled).toBe(true);
  });

  it("ignores late failures from an abandoned target", async () => {
    await act(async () => root.render(createElement(App)));
    let reject!: (error: Error) => void;
    vi.mocked(modrinth.getProjectVersions).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await act(async () => button("26.1.2").click());
    await act(async () => button("26.2").click());
    await act(async () => reject(new TypeError("late failure")));
    expect(container.textContent).not.toContain("Lost contact with Modrinth");
    expect(button("Download zip").disabled).toBe(false);
  });

  it("discards a folder selection that finishes after the plan changes", async () => {
    let choose!: (directory: FileSystemDirectoryHandle) => void;
    window.showDirectoryPicker = vi.fn(() => new Promise<FileSystemDirectoryHandle>((resolve) => { choose = resolve; }));
    const installFolder = vi.spyOn(install, "installToFolder").mockResolvedValue(undefined);
    await act(async () => root.render(createElement(App)));
    await act(async () => button("Install into folder").click());
    await act(async () => button("26.1.2").click());
    await act(async () => choose({ name: "game", getDirectoryHandle: async () => ({}) } as unknown as FileSystemDirectoryHandle));
    expect(installFolder).not.toHaveBeenCalled();
    expect(button("Install into folder").disabled).toBe(false);
  });
});
