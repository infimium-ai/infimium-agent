import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import detectPort from "detect-port";
import express from "express";
import open from "open";

import { createPlaygroundRouter } from "../playground/api.js";
import { trackTelemetry } from "../telemetry.js";

const DEFAULT_PLAYGROUND_PORT = 1434;
const PLAYGROUND_HOST = "127.0.0.1";

export type PlaygroundOptions = {
  openBrowser?: boolean;
  preferredPort?: number;
  projectPath?: string;
};

export async function runPlaygroundCommand(
  options: PlaygroundOptions = {}
): Promise<void> {
  const staticDirectory = resolvePlaygroundDirectory();
  const indexPath = join(staticDirectory, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(
      `Playground build not found at ${staticDirectory}. Run: npm run build:playground`
    );
  }

  const app = express();
  app.disable("x-powered-by");
  app.use("/api", createPlaygroundRouter(options.projectPath ?? process.cwd()));
  app.use(express.static(staticDirectory, { index: false }));
  app.use((_request, response) => {
    response.sendFile(indexPath);
  });

  const port = await detectPort(options.preferredPort ?? DEFAULT_PLAYGROUND_PORT);
  await new Promise<void>((resolveListening, rejectListening) => {
    const server = app.listen(port, PLAYGROUND_HOST, (error?: Error) => {
      if (error) {
        rejectListening(error);
        return;
      }
      resolveListening();
    });
    server.once("error", rejectListening);
  });

  const url = `http://localhost:${port}`;
  console.log(`🚀 Infimium Playground running at ${url}`);
  await trackTelemetry("playground_opened");

  if (options.openBrowser !== false) {
    try {
      await open(url);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not open the browser automatically: ${message}`);
    }
  }
}

function resolvePlaygroundDirectory(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "dist/playground-ui"),
    join(currentDirectory, "../playground-ui"),
    resolve(currentDirectory, "../../playground-ui"),
    resolve(currentDirectory, "../../dist/playground-ui")
  ];

  return candidates.find(
    (candidate) =>
      existsSync(join(candidate, "index.html")) &&
      existsSync(join(candidate, "assets"))
  ) ?? candidates[0];
}
