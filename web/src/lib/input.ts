/** Pull a collection id out of a URL, or return the trimmed input as-is. */
export function parseCollectionInput(input: string): string {
  const match = input.match(/(?:https?:\/\/)?(?:www\.)?modrinth\.com\/collection\/([^/?#\s]+)/);
  return match ? match[1] : input.trim();
}

/** Turn a pasted link into a collection id, or explain what's wrong with it. */
export function readCollectionInput(raw: string): { id: string } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: "Paste a collection link or ID." };
  const page = text.match(/modrinth\.com\/(mod|modpack|resourcepack|shader|datapack|plugin|user|organization)s?\//);
  if (page) {
    return {
      error:
        page[1] === "user" || page[1] === "organization"
          ? "That's a profile. Open one of its collections and paste that link."
          : "That's a single project. Paste a collection link instead.",
    };
  }
  const id = parseCollectionInput(text);
  if (/[\s/]/.test(id)) return { error: "That doesn't look like a collection link." };
  return { id };
}
