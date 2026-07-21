import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
