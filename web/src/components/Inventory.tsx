import { useState, type ReactNode } from "react";
import { EmptySlot } from "./Slot";

export const COLUMNS = 9;
/** A double chest. Longer lists fold so the actions stay within reach. */
const FOLDED_ROWS = 6;

export function Inventory({
  title,
  aside,
  ids,
  minRows = 1,
  renderSlot,
}: {
  title: string;
  aside?: ReactNode;
  ids: string[];
  minRows?: number;
  renderSlot: (id: string, index: number) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const foldable = ids.length > FOLDED_ROWS * COLUMNS;
  const shown = foldable && !open ? ids.slice(0, FOLDED_ROWS * COLUMNS) : ids;
  const empty = Math.max(minRows * COLUMNS, Math.ceil(shown.length / COLUMNS) * COLUMNS) - shown.length;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 font-pixel text-ink">
        <h3 className="text-[16px]">{title}</h3>
        <span className="text-right text-[14px]">{aside}</span>
      </div>
      <div className="mt-1 grid grid-cols-[repeat(9,calc(var(--s)*18))]">
        {shown.map(renderSlot)}
        {Array.from({ length: empty }, (_, i) => (
          <EmptySlot key={`empty-${i}`} />
        ))}
      </div>
      {foldable && (
        <button
          type="button"
          className="mc-button mt-[calc(var(--s)*2)] w-full text-[15px]"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Show fewer" : `Show all ${ids.length}`}
        </button>
      )}
    </div>
  );
}
