import { loadConfig } from "../config.js";
import type { Config } from "../config.js";
import { CodeIndexer } from "../indexer/code-indexer.js";
import { displayPath, DocIndexer } from "../indexer/doc-indexer.js";
import { ProjectMemoryStore } from "../memory/project-memory.js";
import {
  findWorkspaceManifest,
  findWorkspaceProject,
  loadWorkspace,
  loadWorkspaceForProject,
  type InfimiumWorkspace
} from "../workspace/workspace.js";
import { WorkspaceGraphStore } from "../workspace/workspace-graph.js";

export type IndexPaths = {
  localDocsPath: string | null;
  codebasePath: string | null;
};

export type IndexRunStats = {
  docsFiles: number;
  codeSymbols: number;
  codeFiles: number;
  codeSkipped: number;
  filesPruned: number;
};

export async function runIndexCommand(): Promise<void> {
  const config = loadConfig({ requireSearchApiKey: false });
  const workspaceStartPath = config.codebasePath ?? config.localDocsPath ?? process.cwd();
  const manifestPath = findWorkspaceManifest(workspaceStartPath);
  if (manifestPath) {
    await runIndexForWorkspace(config, loadWorkspace(manifestPath), workspaceStartPath);
    return;
  }

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

  const workspace = loadWorkspaceForProject(projectPath);
  if (workspace) {
    syncWorkspaceGraph(workspace);
  }
}

export async function runIndexForWorkspace(
  config: Config,
  workspace: InfimiumWorkspace,
  activePath: string = process.cwd()
): Promise<void> {
  let docsFiles = 0;
  let codeSymbols = 0;
  let codeFiles = 0;
  let filesPruned = 0;

  console.log(`Indexing workspace ${workspace.name} (${workspace.projects.length} projects)...`);
  for (const project of workspace.projects) {
    console.log(`\n[${project.id}] ${project.path}`);
    const stats = await runIndexForPaths(config, {
      localDocsPath: project.path,
      codebasePath: project.path
    });
    docsFiles += stats.docsFiles;
    codeSymbols += stats.codeSymbols;
    codeFiles += stats.codeFiles;
    filesPruned += stats.filesPruned;
  }

  const graph = syncWorkspaceGraph(workspace);
  const activeProject = findWorkspaceProject(workspace, activePath) ?? workspace.projects[0];
  const memory = new ProjectMemoryStore();
  try {
    if (activeProject) {
      memory.setActiveProjectPath(activeProject.path);
    }
  } finally {
    memory.close();
  }

  console.log(
    `\nWorkspace: ${workspace.projects.length} projects · ${graph.relationships.length} project relationships`
  );
  console.log(
    `Total: ${docsFiles} docs · ${codeSymbols} new symbols across ${codeFiles} changed files · ${filesPruned} pruned files`
  );
}

export async function runIndexForPaths(
  config: Config,
  paths: IndexPaths
): Promise<IndexRunStats> {
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

  return {
    docsFiles,
    codeSymbols,
    codeFiles,
    codeSkipped,
    filesPruned
  };
}

function syncWorkspaceGraph(workspace: InfimiumWorkspace) {
  const store = new WorkspaceGraphStore();
  try {
    return store.sync(workspace);
  } finally {
    store.close();
  }
}
