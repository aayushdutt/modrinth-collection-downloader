const LOADER_NAMES: Record<string, string> = {
  fabric: "Fabric",
  neoforge: "NeoForge",
  quilt: "Quilt",
  forge: "Forge",
};

export const loaderName = (loader: string) => LOADER_NAMES[loader] ?? loader;

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / 1024 / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function slugify(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "collection";
}

/** A list read aloud: "A", "A and B", "A, B and C". */
export function listOf(names: string[]) {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
