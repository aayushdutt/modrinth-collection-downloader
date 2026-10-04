import { dirtTexture, grassTexture } from "../lib/sprite";
import type { ReactNode } from "react";

// Minecraft clouds are flat slabs; each row here is one block.
const CLOUDS = [
  { shape: ["...######.....", ".###########..", "##############", "..##########.."], top: "9%", left: "-2%", block: 18, wide: true },
  { shape: ["..#####...", "#########.", "##########"], top: "22%", left: "70%", block: 16 },
  { shape: ["....####......", "..#########...", "##############"], top: "52%", left: "82%", block: 14 },
  { shape: [".#####....", "#########."], top: "64%", left: "4%", block: 14, wide: true },
];

function Cloud({ shape, block }: { shape: string[]; block: number }) {
  const width = shape[0].length;
  return (
    <svg
      viewBox={`0 0 ${width} ${shape.length}`}
      width={width * block}
      height={shape.length * block}
      className="pixelated fill-white/85 dark:fill-white/[0.07]"
      aria-hidden
    >
      {shape.flatMap((row, y) =>
        [...row].map((ch, x) => (ch === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} /> : null)),
      )}
    </svg>
  );
}

// Scattered with a fixed hash so the night sky is the same on every visit.
const hash = (n: number) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};
const STARS = Array.from({ length: 70 }, (_, i) => ({
  x: hash(i + 1) * 100,
  y: hash(i + 101) * 75,
  size: i % 9 === 0 ? 3 : 2,
}));

export function Sky() {
  return (
    <div
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      style={{ background: "var(--sky)" }}
      aria-hidden
    >
      <div className="absolute inset-0 hidden dark:block">
        {STARS.map((star, i) => (
          <span
            key={i}
            className="absolute bg-white/70"
            style={{ left: `${star.x}%`, top: `${star.y}%`, width: star.size, height: star.size }}
          />
        ))}
      </div>
      {CLOUDS.map((cloud, i) => (
        // Clouds that would sit behind the title are dropped on narrow screens.
        <div
          key={i}
          className={`absolute ${cloud.wide ? "max-sm:hidden" : ""}`}
          style={{ top: cloud.top, left: cloud.left }}
        >
          <Cloud shape={cloud.shape} block={cloud.block} />
        </div>
      ))}
    </div>
  );
}

const GRASS = grassTexture();
const DIRT = dirtTexture();

/** The ground the page stands on: one row of grass blocks over dirt. */
export function Ground({ children }: { children: ReactNode }) {
  return (
    <footer
      className="pixelated mt-20 text-white"
      style={{
        backgroundImage: `${GRASS}, ${DIRT}`,
        backgroundRepeat: "repeat-x, repeat",
        backgroundPosition: "top left, top left",
        backgroundSize: "calc(var(--s) * 16) calc(var(--s) * 16)",
      }}
    >
      <div className="mx-auto max-w-[calc(var(--s)*176)] px-4 pt-[calc(var(--s)*24)] pb-10 text-mc-shadow">
        {children}
      </div>
    </footer>
  );
}
