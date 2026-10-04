import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Relative asset paths, so the build works from any path it's served at.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
