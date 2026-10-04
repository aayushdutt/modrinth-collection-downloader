export type Platform = "windows" | "mac" | "linux" | "other";

export function platform(): Platform {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/.test(ua) && !/Mobile/.test(ua)) return "mac";
  if (/Linux|X11/.test(ua) && !/Android/.test(ua)) return "linux";
  return "other";
}

/** Where the default launcher keeps the game, and how to jump there in a file picker. */
export const GAME_FOLDER: Record<Platform, { path: string; jump: string } | null> = {
  windows: { path: "%APPDATA%\\.minecraft", jump: "paste into the picker's address bar" },
  mac: { path: "~/Library/Application Support/minecraft", jump: "Cmd+Shift+G in the picker" },
  linux: { path: "~/.minecraft", jump: "Ctrl+L in the picker" },
  other: null,
};

/** Chromium on desktop can write straight into a folder the user picks. */
export function supportsFolderAccess() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}
