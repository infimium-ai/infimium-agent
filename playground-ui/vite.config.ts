import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rootDir,
  publicDir: false,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(rootDir, "../dist/playground-ui"),
    emptyOutDir: true
  }
});
