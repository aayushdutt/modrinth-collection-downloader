import { useCallback, useState } from "react";
import { installToFolder, installToZip, type Job, type Target } from "../lib/install";
import { useInstall } from "./useInstall";

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * The two ways to get files: a zip, or straight into a game folder. Handles
 * the folder picker's edge cases (cancelled, blocked, the mods folder itself,
 * a folder without mods/) and remembers how the last run ended.
 */
export function useInstallFlow(jobs: Job[], zipName: string) {
  const install = useInstall();
  const [target, setTarget] = useState<Target>("zip");
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pendingRoot, setPendingRoot] = useState<FileSystemDirectoryHandle | null>(null);

  const clearNotes = () => {
    setNote(null);
    setPendingRoot(null);
  };

  async function installInto(root: FileSystemDirectoryHandle, modsOnly = false) {
    clearNotes();
    setTarget("folder");
    try {
      await install.run((events, signal) => installToFolder(root, jobs, { replace: true, modsOnly, signal }, events));
    } catch (e) {
      if (!isAbort(e)) setNote(`Couldn't write to "${root.name}". Try another folder, or use the zip.`);
    }
  }

  async function chooseFolder() {
    clearNotes();
    let root: FileSystemDirectoryHandle;
    try {
      root = await window.showDirectoryPicker({ id: "minecraft", mode: "readwrite" });
    } catch (e) {
      if (!isAbort(e)) setNote("The browser blocked that folder. Try another, or use the zip.");
      return;
    }
    if (root.name === "mods") {
      // Fine when there's nothing to put next to mods/.
      if (jobs.every((j) => j.item.folder === "mods")) return installInto(root, true);
      setNote("That's the mods folder. Pick the folder it's in.");
      return;
    }
    const hasMods = await root.getDirectoryHandle("mods").then(
      () => true,
      () => false,
    );
    if (hasMods) await installInto(root);
    else setPendingRoot(root);
  }

  async function downloadZip() {
    clearNotes();
    setTarget("zip");
    setSavedAs(null);
    const blob = await install.run((events, signal) => installToZip(jobs, events, signal));
    if (!blob) return;
    saveBlob(blob, zipName);
    setSavedAs(zipName);
  }

  const { reset: resetInstall } = install;
  const reset = useCallback(() => {
    resetInstall();
    setNote(null);
    setPendingRoot(null);
    setSavedAs(null);
  }, [resetInstall]);

  return { ...install, target, savedAs, note, pendingRoot, chooseFolder, installInto, downloadZip, reset };
}

export type InstallFlow = ReturnType<typeof useInstallFlow>;
