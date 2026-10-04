import { useState } from "react";

const SPLASHES = [
  "Dependencies included!",
  "Checksums verified!",
  "No account needed!",
  "Runs in your browser!",
  "Resource packs too!",
  "Fabric, Quilt, NeoForge!",
  "Updates in place!",
];

/** The yellow title-screen splash. */
export function Splash({ text }: { text?: string }) {
  const [fallback] = useState(() => SPLASHES[Math.floor(Math.random() * SPLASHES.length)]);
  return (
    <span
      className="pointer-events-none absolute right-0 bottom-2 origin-center rotate-[-17deg] sm:-right-6 sm:bottom-0"
      aria-hidden
    >
      <span className="block animate-splash font-pixel text-[15px] whitespace-nowrap text-mc-yellow text-mc-shadow sm:text-[20px]">
        {text ?? fallback}
      </span>
    </span>
  );
}
