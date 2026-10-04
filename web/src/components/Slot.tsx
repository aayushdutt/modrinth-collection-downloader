import { useEffect, useState, type CSSProperties } from "react";
import type { Line } from "../lib/describe";
import type { ItemProgress } from "../lib/install";
import type { PlanItem } from "../lib/resolve";
import { sprite } from "../lib/sprite";
import type { Project } from "../lib/types";
import { Tooltip } from "./Tooltip";

const CHECK = sprite(
  ["......#", ".....##", "#...##.", "##.##..", ".###...", "..#...."],
  { "#": "#55ff55" },
);
const CROSS = sprite(["#...#", "##.##", ".###.", "##.##", "#...#"], { "#": "#ff5555" });

export interface SlotProps {
  index: number;
  project: Project | null;
  item?: PlanItem;
  skipped?: boolean;
  progress?: ItemProgress;
  lines: Line[];
  label: string;
  onToggle?: () => void;
  animate?: boolean;
}

function ItemIcon({ project }: { project: Project | null }) {
  const [broken, setBroken] = useState(false);
  if (project?.icon_url && !broken) {
    return (
      <img
        src={project.icon_url}
        alt=""
        draggable={false}
        onError={() => setBroken(true)}
        className="size-full object-cover"
      />
    );
  }
  // No icon: a block tinted with the project's own colour, marked with its initial.
  const color = project?.color != null ? `#${project.color.toString(16).padStart(6, "0")}` : "#6b6b6b";
  return (
    <span
      className="grid size-full place-items-center font-pixel text-[calc(var(--s)*9)] leading-none text-white text-mc-shadow"
      style={{ background: color, boxShadow: "inset calc(var(--s)*-1) calc(var(--s)*-1) 0 rgb(0 0 0 / .3)" }}
    >
      {(project?.title ?? "?").slice(0, 1)}
    </span>
  );
}

export function EmptySlot() {
  return <div className="slot" aria-hidden />;
}

export function Slot({ index, project, item, skipped, progress, lines, label, onToggle, animate }: SlotProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const tipId = `tip-${project?.id ?? index}`;

  useEffect(() => {
    if (!anchor) return;
    const hide = () => setAnchor(null);
    window.addEventListener("scroll", hide, { passive: true });
    return () => window.removeEventListener("scroll", hide);
  }, [anchor]);

  const problem = Boolean(item?.problem);
  const prerelease = item?.version && item.version.version_type && item.version.version_type !== "release";
  const state = progress?.state;
  const fraction =
    state === "downloading" && item?.file ? Math.min(1, progress!.bytes / Math.max(item.file.size, 1)) : null;
  const done = state === "added" || state === "updated" || state === "current" || state === "kept";
  const show = (el: HTMLElement) => setAnchor(el.getBoundingClientRect());

  return (
    <button
      type="button"
      className="slot group cursor-pointer outline-none aria-disabled:cursor-default focus-visible:z-10 focus-visible:outline-[length:var(--s)] focus-visible:outline-white focus-visible:outline-solid"
      aria-label={label}
      aria-pressed={problem ? undefined : !skipped}
      aria-describedby={anchor ? tipId : undefined}
      aria-disabled={!onToggle}
      onClick={onToggle}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setAnchor(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setAnchor(null)}
    >
      <span
        className={`relative block size-full ${animate ? "animate-drop" : ""} ${
          skipped ? "opacity-35 grayscale" : problem ? "grayscale-[.7]" : ""
        }`}
        style={animate ? ({ animationDelay: `${Math.min(index * 18, 500)}ms` } as CSSProperties) : undefined}
      >
        <ItemIcon project={project} />
      </span>

      {problem && !skipped && <span className="absolute inset-[var(--s)] bg-[#ff2020]/35" />}

      {prerelease && !skipped && (
        <span
          className="absolute top-[var(--s)] right-[var(--s)] size-0 border-solid"
          style={{
            borderWidth: "0 calc(var(--s)*5) calc(var(--s)*5) 0",
            borderColor: `transparent ${item!.version!.version_type === "alpha" ? "#ff5555" : "#ffff55"} transparent transparent`,
          }}
        />
      )}

      {fraction !== null && (
        <span className="absolute bottom-[calc(var(--s)*2)] left-[calc(var(--s)*2.5)] h-[calc(var(--s)*2)] w-[calc(var(--s)*13)] bg-black">
          <span
            className="block h-[var(--s)]"
            style={{ width: `${fraction * 100}%`, background: `hsl(${fraction * 120} 100% 50%)` }}
          />
        </span>
      )}

      {(done || state === "failed") && (
        <span
          className="pixelated absolute right-0 bottom-0 bg-contain bg-no-repeat"
          style={{
            width: `calc(var(--s) * ${done ? 7 : 5})`,
            height: `calc(var(--s) * ${done ? 6 : 5})`,
            backgroundImage: done ? CHECK : CROSS,
          }}
        />
      )}

      {/* Minecraft's hover highlight. */}
      <span className="pointer-events-none absolute inset-[var(--s)] bg-white/0 group-hover:bg-white/45" />

      {anchor && <Tooltip anchor={anchor} lines={lines} id={tipId} />}
    </button>
  );
}
