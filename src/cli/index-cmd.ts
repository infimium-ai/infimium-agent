import { loadConfig } from "../config.js";
import { displayPath, DocIndexer, formatDbSize } from "../indexer/doc-indexer.js";

export async function runIndexCommand(): Promise<void> {
  const config = loadConfig();

  if (!config.localDocsPath) {
    throw new Error("Missing LOCAL_DOCS_PATH. Add it to your .env file.");
  }

  const indexer = new DocIndexer(config.localDocsPath);
  const stats = await indexer.index(({ current, total, filePath }) => {
    console.log(
      `Indexing file ${current}/${total}: ${displayPath(config.localDocsPath ?? "", filePath)}`
    );
  });
  const totalFiles = stats.indexedFiles + stats.skippedFiles;

  console.log(
    `Indexed ${totalFiles} files, ${stats.chunks} chunks. DB size: ${formatDbSize(stats.dbSizeBytes)}`
  );
}
