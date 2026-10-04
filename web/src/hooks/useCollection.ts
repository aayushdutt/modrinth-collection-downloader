import { useCallback, useEffect, useState } from "react";
import { readCollectionInput } from "../lib/input";
import { getCollection, getGameVersions, getProjects, NotFoundError } from "../lib/modrinth";
import type { GameVersionTag, Project } from "../lib/types";
import type { Loaded } from "./usePlan";

// Fetched once per visit; version ordering and defaults depend on it.
export const gameVersionTags: Promise<GameVersionTag[]> = getGameVersions().catch(() => []);

export function useGameVersionTags() {
  const [tags, setTags] = useState<GameVersionTag[]>([]);
  useEffect(() => {
    gameVersionTags.then(setTags);
  }, []);
  return tags;
}

/** The projects of a loaded collection that Modrinth still knows about, in collection order. */
export const projectsOf = (loaded: Loaded) =>
  loaded.collection.projects.map((id) => loaded.projects.get(id)).filter((p): p is Project => Boolean(p));

/**
 * Open collections by link or id. `beforeShow` runs in the same update as the
 * new collection appears, so choices made from it (version, loader) don't
 * trigger a wasted lookup for the old ones.
 */
export function useCollection() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (raw: string, beforeShow?: (next: Loaded) => void | Promise<void>) => {
    const parsed = readCollectionInput(raw);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setOpening(true);
    setError(null);
    try {
      const collection = await getCollection(parsed.id);
      const projects = new Map((await getProjects(collection.projects)).map((p) => [p.id, p]));
      const next = { collection, projects, openedAt: Date.now() };
      await beforeShow?.(next);
      setLoaded(next);
    } catch (e) {
      setError(
        e instanceof NotFoundError
          ? "Collection not found. Check the link, and make sure it's public."
          : "Can't reach Modrinth. Check your connection.",
      );
    } finally {
      setOpening(false);
    }
  }, []);

  return { loaded, opening, error, open };
}
