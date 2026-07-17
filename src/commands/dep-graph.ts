import { loadConfig } from "../config.js";
import { runDepGraph } from "../tools/dep-graph.js";

export async function runDepGraphCommand(args: string[] = process.argv.slice(3)): Promise<void> {
  const symbolName = args.join(" ").trim();
  if (!symbolName) {
    throw new Error('Missing symbol name. Usage: infimium dep-graph "runDoctorCommand"');
  }

  const config = loadConfig({ requireSearchApiKey: false });
  console.log(
    runDepGraph(symbolName, {
      codebasePath: config.codebasePath ?? process.cwd()
    })
  );
}
