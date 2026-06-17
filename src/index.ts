import { createInfimiumServer } from "./server.js";

async function main() {
  const server = createInfimiumServer();
  const info = await server.start();

  console.log(
    `Infimium initialized with ${info.toolCount} tools (${server.tools
      .map((tool) => tool.name)
      .join(", ")}).`
  );
}

main().catch((error: unknown) => {
  console.error("Failed to start Infimium:", error);
  process.exitCode = 1;
});
