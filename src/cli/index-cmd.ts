import { loadConfig } from "../config.js";
import type { Config } from "../config.js";
import { CodeIndexer } from "../indexer/code-indexer.js";
import { displayPath, DocIndexer } from "../indexer/doc-indexer.js";
import { ProjectMemoryStore } from "../memory/project-memory.js";

export type IndexPaths = {
  localDocsPath: string | null;
  codebasePath: string | null;
};

export async function runIndexCommand(): Promise<void> {
  const config = loadConfig({ requireSearchApiKey: false });
  await runIndexForPaths(config, {
    localDocsPath: config.localDocsPath,
    codebasePath: config.codebasePath
  });
}

export async function runIndexForProject(projectPath: string): Promise<void> {
  const config = loadConfig({ requireSearchApiKey: false });
  await runIndexForPaths(config, {
    localDocsPath: null,
    codebasePath: projectPath
  });
}

export async function runIndexForPaths(config: Config, paths: IndexPaths): Promise<void> {
  if (!paths.localDocsPath && !paths.codebasePath) {
    throw new Error("Missing LOCAL_DOCS_PATH or CODEBASE_PATH. Add one to your .env file.");
  }

  let docsFiles = 0;
  let codeSymbols = 0;
  let codeFiles = 0;
  let codeSkipped = 0;
  let filesPruned = 0;

  if (paths.localDocsPath) {
    const docIndexer = new DocIndexer(config);
    try {
      const docStats = await docIndexer.indexDirectory(
        paths.localDocsPath,
        ({ current, total, filePath }) => {
          console.log(
            `Indexing [${current}/${total}] ${displayPath(paths.localDocsPath ?? "", filePath)}...`
          );
        }
      );

      docsFiles = docStats.filesIndexed + docStats.filesSkipped;
      filesPruned += docStats.filesPruned;
    } finally {
      docIndexer.close();
    }
  }

  if (paths.codebasePath) {
    const codeIndexer = new CodeIndexer(config);
    try {
      const codeStats = await codeIndexer.indexCodebase(paths.codebasePath);
      codeSymbols = codeStats.symbolsIndexed;
      codeFiles = codeStats.filesProcessed;
      codeSkipped = codeStats.filesSkipped;
      filesPruned += codeStats.filesPruned;
    } finally {
      codeIndexer.close();
    }
  }

  const projectPath = paths.codebasePath ?? paths.localDocsPath ?? process.cwd();
  const memory = new ProjectMemoryStore();
  try {
    memory.remember({
      projectPath,
      eventType: "index",
      summary:
        `Index ran for ${docsFiles} doc files; ` +
        `code processed ${codeFiles} files, skipped ${codeSkipped}, indexed ${codeSymbols} symbols; ` +
        `pruned ${filesPruned} stale files`
    });
  } finally {
    memory.close();
  }

  console.log(`Docs: ${docsFiles} files. Code: ${codeSymbols} symbols across ${codeFiles} files.`);
  if (filesPruned > 0) {
    console.log(`Pruned ${filesPruned} deleted or excluded files from the index.`);
  }
}
