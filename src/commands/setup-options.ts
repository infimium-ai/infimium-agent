export type SetupOptions = {
  installDeps: boolean;
  openPlayground: boolean;
  telemetryEnabled: boolean;
};

export function parseSetupArgs(args: string[]): SetupOptions {
  const options: SetupOptions = {
    installDeps: false,
    openPlayground: true,
    telemetryEnabled: true
  };

  for (const arg of args) {
    if (arg === "--install-deps") {
      options.installDeps = true;
      continue;
    }
    if (arg === "--no-playground") {
      options.openPlayground = false;
      continue;
    }
    if (arg === "--no-telemetry") {
      options.telemetryEnabled = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(setupUsage());
    }
    throw new Error(`Unknown setup argument: ${arg}\n${setupUsage()}`);
  }

  return options;
}

export function setupUsage(): string {
  return [
    "Usage: infimium setup [--install-deps] [--no-playground] [--no-telemetry]",
    "",
    "Runs init, starts Ollama, pulls nomic-embed-text, indexes the current project,",
    "runs doctor, and opens the local Playground."
  ].join("\n");
}
