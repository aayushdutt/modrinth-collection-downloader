/**
 * Tiny pixel-art helpers: turn a character grid into a crisp SVG data URL,
 * so textures stay in code instead of binary assets.
 */
export function sprite(rows: string[], palette: Record<string, string>) {
  const rects: string[] = [];
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (palette[ch]) rects.push(`<rect x='${x}' y='${y}' width='1' height='1' fill='${palette[ch]}'/>`);
    }),
  );
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${rows[0].length} ${rows.length}' shape-rendering='crispEdges'>${rects.join("")}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Deterministic noise so textures look the same on every load. */
function noise(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function dirtRow(rand: () => number) {
  return Array.from({ length: 16 }, () => {
    const r = rand();
    return r < 0.12 ? "s" : r < 0.2 ? "l" : r < 0.24 ? "k" : "d";
  }).join("");
}

const EARTH = { d: "#866043", s: "#6c4b30", l: "#9a7556", k: "#593d29", g: "#5d9c3a", G: "#79c05a", n: "#4a7f2c" };

export function dirtTexture() {
  const rand = noise(7);
  return sprite(Array.from({ length: 16 }, () => dirtRow(rand)), EARTH);
}

export function grassTexture() {
  const rand = noise(42);
  const green = () => (rand() < 0.2 ? "G" : rand() < 0.25 ? "n" : "g");
  const rows = Array.from({ length: 16 }, (_, y) => {
    if (y < 3) return Array.from({ length: 16 }, green).join("");
    if (y < 5) {
      const keep = y === 3 ? 0.65 : 0.25;
      return Array.from({ length: 16 }, () => (rand() < keep ? green() : "d")).join("");
    }
    return dirtRow(rand);
  });
  return sprite(rows, EARTH);
}
