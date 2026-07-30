export type ParsedIndexArgs = {
  acceptWorkspace: boolean;
  detectWorkspace: boolean;
  openPlayground: boolean;
  verbose: boolean;
};

export function parseIndexArgs(args: string[]): ParsedIndexArgs {
  let acceptWorkspace = false;
  let detectWorkspace = true;
  let openPlayground = true;
  let verbose = false;

  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") {
      acceptWorkspace = true;
      continue;
    }
    if (arg === "--no-workspace") {
      detectWorkspace = false;
      continue;
    }
    if (arg === "--no-playground") {
      openPlayground = false;
      continue;
    }
    if (arg === "--playground") {
      openPlayground = true;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
      continue;
    }
    throw new Error(
      `Unknown index argument: ${arg}. Use --yes, --no-workspace, --no-playground, or --verbose.`
    );
  }

  return { acceptWorkspace, detectWorkspace, openPlayground, verbose };
}
