import type { ReactNode } from "react";
import { sprite } from "../lib/sprite";

const TICK = sprite(
  ["......#", ".....##", "#...##.", "##.##..", ".###...", "..#...."],
  { "#": "#e0e0e0" },
);

export function Checkbox({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 has-disabled:cursor-default has-disabled:opacity-60">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        className="pixelated mt-0.5 size-[calc(var(--s)*8)] shrink-0 border-[length:var(--s)] border-[#a0a0a0] bg-black bg-[length:70%] bg-center bg-no-repeat peer-hover:border-white peer-focus-visible:border-white"
        style={{ backgroundImage: checked ? TICK : undefined }}
        aria-hidden
      />
      <span className="text-[15px] leading-snug">{children}</span>
    </label>
  );
}
