import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CollectionForm } from "./components/CollectionForm";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { InstallActions } from "./components/InstallActions";
import { PlanGrid } from "./components/PlanGrid";
import { Sky } from "./components/Sky";
import { StatusLine } from "./components/StatusLine";
import { TargetPicker } from "./components/TargetPicker";
import { gameVersionTags, projectsOf, useCollection, useGameVersionTags } from "./hooks/useCollection";
import { useInstallFlow } from "./hooks/useInstallFlow";
import { usePlan } from "./hooks/usePlan";
import { readShareUrl, useShareUrl } from "./hooks/useShareUrl";
import { slugify } from "./lib/format";
import { fitsInZip, jobsFor } from "./lib/install";
import { installSet } from "./lib/resolve";
import { planSummary, type SummaryLine } from "./lib/summary";
import { pickTarget } from "./lib/versions";

const shared = readShareUrl();

export default function App() {
  const tags = useGameVersionTags();
  const { loaded, opening, error: openError, open } = useCollection();
  const [gameVersion, setGameVersion] = useState(shared.gameVersion);
  const [loader, setLoader] = useState(shared.loader);
  const [prerelease, setPrerelease] = useState(shared.prerelease);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const { plan, checked, resolving, throttled, error: resolveError } = usePlan(
    loaded,
    gameVersion,
    loader,
    prerelease ? "alpha" : "release",
    attempt,
  );

  const projects = useMemo(() => (loaded ? projectsOf(loaded) : []), [loaded]);
  const roots = useMemo(() => loaded?.collection.projects ?? [], [loaded]);
  const items = useMemo(() => [...installSet(plan, roots, skipped)].map((id) => plan.get(id)!), [plan, roots, skipped]);
  const jobs = useMemo(() => jobsFor(items), [items]);
  const totalBytes = jobs.reduce((n, j) => n + j.item.file.size, 0);
  const nameOf = useCallback(
    (id: string) => plan.get(id)?.project?.title ?? loaded?.projects.get(id)?.title ?? id,
    [plan, loaded],
  );

  const flow = useInstallFlow(jobs, `${slugify(loaded?.collection.name ?? "")}-${gameVersion}-${loader}.zip`);
  const { reset: resetFlow } = flow;
  // A new plan makes the last run's results stale.
  useEffect(() => resetFlow(), [plan, resetFlow]);

  useShareUrl(loaded && { collection: loaded.collection.id, gameVersion, loader, prerelease });

  const openCollection = useCallback(
    (raw: string) =>
      open(raw, async (next) => {
        const target = pickTarget(projectsOf(next), { gameVersion, loader }, await gameVersionTags);
        setLoader(target.loader);
        setGameVersion(target.gameVersion);
        setSkipped(new Set());
        setOnlyProblems(false);
      }),
    [open, gameVersion, loader],
  );

  // Open a shared link straight away, once.
  const openedShared = useRef(false);
  useEffect(() => {
    if (openedShared.current || !shared.collection) return;
    openedShared.current = true;
    openCollection(shared.collection);
  }, [openCollection]);

  const toggle = (id: string) =>
    setSkipped((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const onAction = (action: NonNullable<SummaryLine["action"]>) => {
    if (action === "show-problems") setOnlyProblems(true);
    if (action === "use-betas") setPrerelease(true);
  };

  const busy = flow.phase === "running";
  const hasProjects = Boolean(loaded) && roots.length > 0;
  const showProblems = onlyProblems && items.some((i) => i.problem);
  const summary = useMemo(
    () => (plan.size ? planSummary(items, jobs, skipped, { gameVersion, loader, nameOf }) : []),
    [plan, items, jobs, skipped, gameVersion, loader, nameOf],
  );

  return (
    <>
      <Sky />
      <main className="mx-auto w-full max-w-[calc(var(--s)*176+2rem)] px-4 pt-12 sm:pt-20">
        <Header />
        <section
          className="gui px-[calc(var(--s)*6)] pt-[calc(var(--s)*6)] pb-[calc(var(--s)*8)]"
          aria-labelledby="gui-title"
        >
          <CollectionForm
            loaded={loaded}
            initialInput={shared.collection}
            opening={opening}
            error={openError}
            disabled={busy}
            onOpen={openCollection}
          />
          {loaded && !hasProjects && <p className="mt-4 text-[15px] font-bold">This collection is empty.</p>}
          {hasProjects && (
            <TargetPicker
              projects={projects}
              tags={tags}
              gameVersion={gameVersion}
              loader={loader}
              prerelease={prerelease}
              disabled={busy}
              onGameVersion={setGameVersion}
              onLoader={setLoader}
              onPrerelease={setPrerelease}
            />
          )}
          <PlanGrid
            loaded={loaded}
            plan={plan}
            skipped={skipped}
            progress={flow.progress}
            ctx={{ gameVersion, loader, target: flow.target, busy, nameOf }}
            onlyProblems={showProblems}
            onShowAll={() => setOnlyProblems(false)}
            onToggle={toggle}
          />
          {hasProjects && (
            <div className="mt-6">
              <StatusLine
                flow={flow}
                resolving={resolving}
                resolveError={resolveError}
                checked={checked}
                rootCount={roots.length}
                throttled={throttled}
                summary={summary}
                totalBytes={totalBytes}
                jobCount={jobs.length}
                onlyProblems={showProblems}
                nameOf={nameOf}
                onRetry={() => setAttempt((n) => n + 1)}
                onAction={onAction}
              />
              <InstallActions
                flow={flow}
                jobCount={jobs.length}
                ready={!resolving && jobs.length > 0}
                tooBigForZip={!fitsInZip(jobs)}
              />
            </div>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}
