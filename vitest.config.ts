import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.{test,spec}.{js,mjs,cjs,ts,jsx,tsx}"],
    env: {
      INFIMIUM_DATA_DIR: `/tmp/infimium-vitest-${process.pid}`,
      INFIMIUM_TELEMETRY: "false"
    },
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/infimium-agent/**"
    ]
  }
});
