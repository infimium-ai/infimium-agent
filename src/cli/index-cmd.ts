import { loadConfig } from "../config.js";
import { CodeIndexer } from "../indexer/code-indexer.js";
import { displayPath, DocIndexer } from "../indexer/doc-indexer.js";

export async function runIndexCommand(): Promise<void> {
  const config = loadConfig({ requireSearchApiKey: false });

  if (!config.localDocsPath && !config.codebasePath) {
    throw new Error("Missing LOCAL_DOCS_PATH or CODEBASE_PATH. Add one to your .env file.");
  }

  let docsFiles = 0;
  let codeSymbols = 0;
  let codeFiles = 0;

  if (config.localDocsPath) {
    const docIndexer = new DocIndexer(config);
    try {
      const docStats = await docIndexer.indexDirectory(
        config.localDocsPath,
        ({ current, total, filePath }) => {
          console.log(
            `Indexing [${current}/${total}] ${displayPath(config.localDocsPath ?? "", filePath)}...`
          );
        }
      );

      docsFiles = docStats.filesIndexed + docStats.filesSkipped;
    } finally {
      docIndexer.close();
    }
  }

  if (config.codebasePath) {
    const codeIndexer = new CodeIndexer(config);
    try {
      const codeStats = await codeIndexer.indexCodebase(config.codebasePath);
      codeSymbols = codeStats.symbolsIndexed;
      codeFiles = codeStats.filesProcessed;
    } finally {
      codeIndexer.close();
    }
  }

  console.log(`Docs: ${docsFiles} files. Code: ${codeSymbols} symbols across ${codeFiles} files.`);
}
