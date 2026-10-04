import type { Loaded } from "../hooks/usePlan";
import { describeSlot, type SlotContext } from "../lib/describe";
import type { ItemProgress } from "../lib/install";
import type { PlanItem } from "../lib/resolve";
import { Inventory } from "./Inventory";
import { Slot } from "./Slot";
import { TextButton } from "./TextButton";

/** The collection and its dependencies as inventory grids, or just the problem items. */
export function PlanGrid({
  loaded,
  plan,
  skipped,
  progress,
  ctx,
  onlyProblems,
  onShowAll,
  onToggle,
}: {
  loaded: Loaded | null;
  plan: Map<string, PlanItem>;
  skipped: Set<string>;
  progress: Record<string, ItemProgress>;
  ctx: SlotContext;
  onlyProblems: boolean;
  onShowAll(): void;
  onToggle(id: string): void;
}) {
  const roots = loaded?.collection.projects ?? [];
  const deps = [...plan.values()]
    .filter((i) => i.role === "dependency")
    .sort((a, b) => ctx.nameOf(a.id).localeCompare(ctx.nameOf(b.id)))
    .map((i) => i.id);
  const visible = (ids: string[]) => (onlyProblems ? ids.filter((id) => plan.get(id)?.problem) : ids);
  const kept = roots.filter((id) => !skipped.has(id)).length;

  const slot = (animate: boolean) => (id: string, index: number) => {
    const item = plan.get(id);
    const project = item?.project ?? loaded?.projects.get(id) ?? null;
    const { lines, label } = describeSlot(project, item, { skipped: skipped.has(id), progress: progress[id] }, ctx);
    return (
      <Slot
        key={id}
        index={index}
        project={project}
        item={item}
        skipped={skipped.has(id)}
        progress={progress[id]}
        lines={lines}
        label={label}
        animate={animate}
        onToggle={item && !item.problem && !ctx.busy ? () => onToggle(id) : undefined}
      />
    );
  };

  const depIds = visible(deps);
  return (
    <div className="mt-6 space-y-4">
      <Inventory
        key={loaded?.openedAt ?? "empty"}
        title={onlyProblems ? "Not available" : "Collection"}
        minRows={onlyProblems ? 1 : 3}
        ids={visible(roots)}
        renderSlot={slot(!onlyProblems)}
        aside={
          onlyProblems ? (
            <TextButton className="underline-offset-4" onClick={onShowAll}>
              Back to all
            </TextButton>
          ) : loaded ? (
            kept === roots.length ? `${roots.length} ${roots.length === 1 ? "project" : "projects"}` : `${kept} of ${roots.length}`
          ) : null
        }
      />
      {depIds.length > 0 && <Inventory title="Dependencies" ids={depIds} renderSlot={slot(false)} aside={depIds.length} />}
    </div>
  );
}
