import { useEffect, useState } from "react";
import * as modrinth from "../lib/modrinth";
import { buildPlan, type PlanItem } from "../lib/resolve";
import type { Channel, Collection, Project } from "../lib/types";

export interface Loaded {
  collection: Collection;
  projects: Map<string, Project>;
  /** Distinguishes reopening the same collection. */
  openedAt: number;
}

const NO_PLAN = new Map<string, PlanItem>();

interface Resolved {
  key: string;
  plan: Map<string, PlanItem>;
}

/**
 * Re-resolve the collection whenever the target changes. The previous plan
 * stays on screen until the new one is complete, so slots don't flicker.
 */
export function usePlan(
  loaded: Loaded | null,
  gameVersion: string,
  loader: string,
  channel: Channel,
  /** Bump to retry after a failure. */
  attempt = 0,
) {
  const key = loaded && gameVersion ? `${loaded.openedAt}|${gameVersion}|${loader}|${channel}|${attempt}` : "";
  const [resolved, setResolved] = useState<Resolved>({ key: "", plan: new Map() });
  const [checked, setChecked] = useState({ key: "", count: 0 });
  const [failed, setFailed] = useState("");
  const [throttled, setThrottled] = useState(false);

  useEffect(() => modrinth.onThrottle(setThrottled), []);

  useEffect(() => {
    if (!loaded || !key) return;
    const controller = new AbortController();
    const { signal } = controller;
    let count = 0;
    let frame = 0;

    buildPlan(
      {
        getProjects: (ids) => modrinth.getProjects(ids, signal),
        getProjectVersions: (id, v) => modrinth.getProjectVersions(id, v, signal),
        getVersions: (ids) => modrinth.getVersions(ids, signal),
        pool: modrinth.pool,
      },
      loaded.collection.projects,
      loaded.projects,
      { gameVersion, loader, channel },
      () => {
        count++;
        frame ||= requestAnimationFrame(() => {
          frame = 0;
          setChecked({ key, count });
        });
      },
    )
      .then((plan) => {
        if (!signal.aborted) setResolved({ key, plan });
      })
      .catch(() => {
        if (!signal.aborted) setFailed(key);
      });

    return () => {
      controller.abort();
      cancelAnimationFrame(frame);
    };
  }, [key, loaded, gameVersion, loader, channel]);

  const error = key && failed === key;
  // Only show a stale plan while re-resolving the same collection.
  const current = Boolean(loaded) && resolved.key.startsWith(`${loaded!.openedAt}|`);
  return {
    plan: key && current ? resolved.plan : NO_PLAN,
    checked: checked.key === key ? checked.count : 0,
    resolving: Boolean(key) && resolved.key !== key && !error,
    /** Modrinth is rate limiting this pass; large collections slow down. */
    throttled,
    error: error ? "Lost contact with Modrinth while checking versions." : null,
  };
}
