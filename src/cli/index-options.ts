export type ParsedIndexArgs = {
  acceptWorkspace: boolean;
  detectWorkspace: boolean;
  openPlayground: boolean;
};

export function parseIndexArgs(args: string[]): ParsedIndexArgs {
  let acceptWorkspace = false;
  let detectWorkspace = true;
  let openPlayground = true;

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
    throw new Error(
      `Unknown index argument: ${arg}. Use --yes, --no-workspace, or --no-playground.`
    );
  }

  return { acceptWorkspace, detectWorkspace, openPlayground };
}
