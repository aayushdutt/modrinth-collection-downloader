import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Line } from "../lib/describe";

/** Minecraft's item tooltip, placed beside its slot and kept on screen. */
export function Tooltip({ anchor, lines, id }: { anchor: DOMRect; lines: Line[]; id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const gap = 8;
    let left = anchor.right + gap;
    if (left + width > window.innerWidth - gap) left = anchor.left - width - gap;
    left = Math.max(gap, left);
    const top = Math.min(Math.max(gap, anchor.top - gap), window.innerHeight - height - gap);
    setPos({ left, top });
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="mc-tooltip pointer-events-none fixed z-50 max-w-72 text-[15px] leading-snug"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0 }}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className={`text-mc-shadow ${i === 0 ? "mb-1 text-[17px]" : ""} ${line.italic ? "italic" : ""}`}
          style={{ color: line.color }}
        >
          {line.text}
        </div>
      ))}
    </div>,
    document.body,
  );
}
