import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  Activity,
  ArrowRight,
  Binary,
  Braces,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Database,
  FileCode2,
  Folder,
  GitBranch,
  Moon,
  Network,
  Search,
  Sun,
  TerminalSquare,
  X
} from "lucide-react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";

type ViewId = "pulse" | "graph" | "index" | "economics";
type ThemeMode = "dark" | "light";
type RetrievalStrategy = "Full Implementation Text" | "Semantic Chunks" | "Infimium AST Skeletons";

type NavigationItem = {
  id: ViewId;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
};

type Health = {
  ollama: boolean;
  mcp: boolean;
  sqlite: boolean;
  vectorStore: string;
};

type Pulse = {
  projectPath: string;
  contextPath: string | null;
  currentTask: string | null;
  recentMemory: Array<{ type: string; summary: string; createdAt: string | null }>;
  workingTree: {
    dirty: boolean;
    totalChangedFiles: number;
    summary: string;
    changedFiles: Array<{ status: string; path: string }>;
  };
  index: {
    codeSymbols: number;
    codeFiles: number;
    docsFiles: number;
    docsChunks: number;
    depGraphRelationships: number;
    lastIndexedAt: string | null;
  } | null;
};

type Graph = {
  name: string;
  nodes: Array<{
    id: string;
    label: string;
    type: "workspace" | "project" | "module" | "file";
    role: string | null;
    memberCount?: number;
    fx?: number;
    fy?: number;
  }>;
  edges: Array<{ source: string; target: string; type: string; weight: number }>;
};

type GraphMode = "modules" | "files";

type SymbolItem = {
  id: string;
  name: string;
  type: string;
  language: string;
  relativePath: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  skeleton: string;
  fullImplementation: string;
  projectId: string;
  projectName: string;
  projectPath: string;
};

type SymbolPage = {
  page: number;
  limit: number;
  total: number;
  items: SymbolItem[];
};

type Metrics = {
  symbolCount: number;
  averageSkeletonTokens: number;
  averageFullTextTokens: number;
  observedAverageSkeletonTokens: number;
  observedAverageFullTextTokens: number;
  astFirstTokens: number;
  fullTextTokens: number;
  totalTokensSaved: number;
  savingsPercent: number;
  usdPerMillionInputTokens: number;
  estimatedUsdSaved: number;
};

type IndexFiles = {
  projectPath: string;
  scope: "project" | "workspace";
  indexedFiles: number;
  indexedSymbols: number;
  excludedByInfimiumIgnore: number;
  ignoreFilePresent: boolean;
  files: Array<{
    path: string;
    language: string;
    symbolCount: number;
    projectId: string;
    projectName: string;
    projectPath: string;
  }>;
};

type LogFeed = {
  projectPath: string;
  scope: "project" | "workspace";
  source: "sqlite" | "context" | "empty";
  items: Array<{
    id: string;
    type: string;
    message: string;
    details: string | null;
    createdAt: string | null;
    projectId: string;
    projectName: string;
    projectPath: string;
  }>;
};

type PlaygroundScope = {
  mode: "single-project" | "watched-projects" | "workspace";
  activeWorkspaceId: string | null;
  workspaceName: string | null;
  activeProjectPath: string;
  workspaces: Array<{
    id: string;
    name: string;
    active: boolean;
    projects: Array<{
      id: string;
      name: string;
      path: string;
      role: string | null;
      active: boolean;
    }>;
  }>;
  projects: Array<{
    id: string;
    name: string;
    path: string;
    role: string | null;
    active: boolean;
  }>;
};

const navigation: NavigationItem[] = [
  { id: "pulse", label: "The Pulse", icon: Activity },
  { id: "graph", label: "Knowledge Graph", icon: Network },
  { id: "index", label: "Index & Logs", icon: Braces },
  { id: "economics", label: "Token Economics", icon: Binary }
];

const viewCopy: Record<ViewId, { eyebrow: string; title: string }> = {
  pulse: { eyebrow: "Runtime / Live", title: "The Pulse" },
  graph: { eyebrow: "Topology / Workspace", title: "Knowledge Graph" },
  index: { eyebrow: "Retrieval / Activity", title: "Index Explorer & Logs" },
  economics: { eyebrow: "Efficiency / Context", title: "Token Economics" }
};

function readInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  return window.localStorage.getItem("infimium-playground-theme") === "light"
    ? "light"
    : "dark";
}

function cssVariable(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function App() {
  const [activeView, setActiveView] = useState<ViewId>("pulse");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [selectedProjectPath, setSelectedProjectPath] = useState("");
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);
  const scope = useApi<PlaygroundScope>("/api/scope");
  const availableWorkspaces = scope.data?.workspaces.length
    ? scope.data.workspaces
    : scope.data
      ? [{
        id: "default",
        name: scope.data.workspaceName ?? "Local projects",
        active: true,
        projects: scope.data.projects
      }]
      : [];
  const selectedWorkspace =
    availableWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
    availableWorkspaces.find((workspace) => workspace.active) ??
    availableWorkspaces[0];
  const selectedProject = selectedWorkspace?.projects.find(
    (project) => project.path === selectedProjectPath
  ) ?? selectedWorkspace?.projects.find((project) => project.active) ?? selectedWorkspace?.projects[0];
  const projectPath = selectedProject?.path ?? "";
  const health = useApi<Health>(withProject("/api/health", projectPath));
  const active = viewCopy[activeView];
  const databaseOnline = health.data?.sqlite ?? false;

  useEffect(() => {
    if (!scope.data || selectedWorkspaceId) return;
    setSelectedWorkspaceId(scope.data.activeWorkspaceId ?? availableWorkspaces[0]?.id ?? "");
  }, [availableWorkspaces, scope.data, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    const currentProjectExists = selectedWorkspace.projects.some(
      (project) => project.path === selectedProjectPath
    );
    if (currentProjectExists) return;
    setSelectedProjectPath(
      selectedWorkspace.projects.find((project) => project.active)?.path ??
      selectedWorkspace.projects[0]?.path ??
      scope.data?.activeProjectPath ??
      ""
    );
  }, [scope.data?.activeProjectPath, selectedProjectPath, selectedWorkspace]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("infimium-playground-theme", theme);
  }, [theme]);

  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <img src="/infimium-logo.png" alt="" />
          </div>
          <div>
            <p className="brand-name">Infimium</p>
            <p className="brand-mode">PLAYGROUND</p>
          </div>
        </div>

        <nav className="nav-list" aria-label="Playground views">
          {navigation.map((item) => {
            const Icon = item.icon;
            const selected = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`nav-item${selected ? " is-active" : ""}`}
                onClick={() => setActiveView(item.id)}
              >
                <Icon size={18} strokeWidth={1.8} />
                <span>{item.label}</span>
                {selected ? <ChevronRight size={15} /> : null}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-status">
          <div className="status-row">
            <span className={`status-light${databaseOnline ? "" : " is-offline"}`} />
            <span>LOCAL ONLY</span>
          </div>
          <p>Read-only observer</p>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{active.eyebrow}</p>
            <h1>{active.title}</h1>
          </div>
          <div className="topbar-controls">
            <button
              type="button"
              className="theme-toggle"
              aria-label={`Switch to ${nextTheme} mode`}
              title={`Switch to ${nextTheme} mode`}
              onClick={() => setTheme(nextTheme)}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            {availableWorkspaces.length > 1 ? (
              <label className="workspace-picker">
                <span>{availableWorkspaces.length} WORKSPACE{availableWorkspaces.length === 1 ? "" : "S"}</span>
                <select
                  aria-label="Active workspace"
                  value={selectedWorkspace?.id ?? ""}
                  onChange={(event) => {
                    const nextWorkspace = availableWorkspaces.find(
                      (workspace) => workspace.id === event.target.value
                    );
                    setSelectedWorkspaceId(event.target.value);
                    setSelectedProjectPath(
                      nextWorkspace?.projects.find((project) => project.active)?.path ??
                      nextWorkspace?.projects[0]?.path ??
                      ""
                    );
                  }}
                >
                  {availableWorkspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {selectedWorkspace && selectedProject ? (
              <label className="project-picker">
                <span>{selectedWorkspace.projects.length} PROJECT{selectedWorkspace.projects.length === 1 ? "" : "S"}</span>
                <select
                  aria-label="Active project context"
                  value={selectedProject.path}
                  onChange={(event) => setSelectedProjectPath(event.target.value)}
                >
                  {selectedWorkspace.projects.map((project) => (
                    <option key={project.id} value={project.path}>{project.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="health-cluster">
              <HealthBadge label="OLLAMA" online={health.data?.ollama ?? false} />
              <HealthBadge label="DATABASE" online={databaseOnline} />
              <HealthBadge label="MCP" online={health.data?.mcp ?? false} readyLabel />
            </div>
          </div>
        </header>

        <section className="content-grid" aria-live="polite">
          {activeView === "pulse" ? <PulseView projectPath={projectPath} /> : null}
          {activeView === "graph" ? <GraphView projectPath={projectPath} theme={theme} /> : null}
          {activeView === "index" && scope.data && selectedWorkspace ? (
            <IndexView
              projectPath={projectPath}
              scopeData={scopeForSelectedWorkspace(scope.data, selectedWorkspace, projectPath)}
            />
          ) : null}
          {activeView === "economics" ? <EconomicsView projectPath={projectPath} /> : null}
        </section>
      </main>
    </div>
  );
}

function PulseView({ projectPath }: { projectPath: string }) {
  const pulse = useApi<Pulse>(withProject("/api/pulse", projectPath));
  if (pulse.loading) return <LoadingPanel label="Reading local context layer" />;
  if (pulse.error || !pulse.data) return <ErrorPanel message={pulse.error} />;

  const data = pulse.data;
  const task = data.currentTask ?? "Awaiting first agent interaction...";
  const index = data.index;

  return (
    <>
      <article className="panel panel-wide task-panel">
        <div className="panel-heading">
          <div>
            <p className="panel-label">CURRENT TASK</p>
            <h2>{task}</h2>
            <p className="path-note">{data.projectPath}</p>
          </div>
          <CircleDot size={20} />
        </div>
        <div className="signal-line" />
      </article>
      <MetricPanel
        icon={Database}
        label="INDEX"
        value={formatNumber(index?.codeSymbols ?? 0)}
        note={`${formatNumber(index?.codeFiles ?? 0)} files · ${formatNumber(index?.depGraphRelationships ?? 0)} graph edges`}
      />
      <MetricPanel
        icon={GitBranch}
        label="WORKING TREE"
        value={formatNumber(data.workingTree.totalChangedFiles)}
        note={data.workingTree.summary}
      />
      <article className="panel changed-panel">
        <p className="panel-label">CHANGED FILES</p>
        {data.workingTree.changedFiles.length > 0 ? (
          <div className="file-list">
            {data.workingTree.changedFiles.map((file) => (
              <div className="file-row" key={`${file.status}:${file.path}`}>
                <span className="file-status">{file.status}</span>
                <span>{file.path}</span>
              </div>
            ))}
          </div>
        ) : <EmptyLine text="Working tree is clean" />}
      </article>
      <article className="panel memory-panel">
        <p className="panel-label">RECENT MEMORY</p>
        {data.recentMemory.length > 0 ? (
          <div className="memory-list">
            {data.recentMemory.slice(0, 6).map((memory, indexValue) => (
              <div className="memory-row" key={`${memory.createdAt}:${indexValue}`}>
                <span>{memory.type}</span>
                <p>{memory.summary}</p>
                <time>{formatDate(memory.createdAt)}</time>
              </div>
            ))}
          </div>
        ) : <EmptyLine text="No project memory recorded yet" />}
      </article>
    </>
  );
}

function scopeForSelectedWorkspace(
  scope: PlaygroundScope,
  workspace: PlaygroundScope["workspaces"][number],
  projectPath: string
): PlaygroundScope {
  return {
    ...scope,
    activeWorkspaceId: workspace.id,
    workspaceName: workspace.name,
    activeProjectPath: projectPath,
    projects: workspace.projects.map((project) => ({
      ...project,
      active: project.path === projectPath
    })),
    workspaces: scope.workspaces.map((candidate) => ({
      ...candidate,
      active: candidate.id === workspace.id,
      projects: candidate.projects.map((project) => ({
        ...project,
        active: candidate.id === workspace.id && project.path === projectPath
      }))
    }))
  };
}

function GraphView({ projectPath, theme }: { projectPath: string; theme: ThemeMode }) {
  const [mode, setMode] = useState<GraphMode>("modules");
  const graph = useApi<Graph>(withProject("/api/workspace", projectPath));
  const visibleGraph = useMemo(() => {
    if (!graph.data) return null;
    return mode === "modules"
      ? collapseGraphToModules(graph.data)
      : selectConnectedFiles(graph.data, 16);
  }, [graph.data, mode]);
  if (graph.loading) return <LoadingPanel label="Reading dependency topology" />;
  if (graph.error || !graph.data || !visibleGraph) return <ErrorPanel message={graph.error} />;

  return (
    <article className="panel panel-full graph-stage">
      <div className="graph-toolbar">
        <div>
          <p className="panel-label">{graph.data.name.toUpperCase()}</p>
          <p>
            {visibleGraph.nodes.length} {mode === "modules" ? "modules" : "visible nodes"}
            {" · "}{visibleGraph.edges.length} connections
          </p>
        </div>
        <div className="graph-actions">
          <div className="graph-mode" role="tablist" aria-label="Graph detail">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "modules"}
              className={mode === "modules" ? "is-active" : ""}
              onClick={() => setMode("modules")}
            >
              Modules
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "files"}
              className={mode === "files" ? "is-active" : ""}
              onClick={() => setMode("files")}
            >
              Files
            </button>
          </div>
          <div className="graph-legend"><span /> hover to focus</div>
        </div>
      </div>
      {graph.data.nodes.length > 1 ? (
        <NetworkGraph graph={visibleGraph} mode={mode} theme={theme} />
      ) : (
        <div className="center-empty">
          <Network size={24} />
          <p>No project-scoped graph edges found.</p>
          <span>Run `infimium index` in this repository.</span>
        </div>
      )}
    </article>
  );
}

function NetworkGraph({ graph, mode, theme }: { graph: Graph; mode: GraphMode; theme: ThemeMode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<Graph["nodes"][number], Graph["edges"][number]> | undefined>(undefined);
  const [size, setSize] = useState({ width: 900, height: 560 });
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const { graphData, labeledNodeIds, relatedNodeIds } = useMemo(() => {
    const degree = new Map<string, number>();
    graph.edges.forEach((edge) => {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    });
    const labels = new Set(
      graph.nodes
        .filter((node) => node.type !== "file")
        .map((node) => node.id)
    );
    if (mode === "files") {
      graph.nodes
        .filter((node) => node.type === "file")
        .sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0))
        .slice(0, 5)
        .forEach((node) => labels.add(node.id));
    }
    const related = new Set<string>();
    if (hoveredNodeId) {
      related.add(hoveredNodeId);
      graph.edges.forEach((edge) => {
        if (edge.source === hoveredNodeId) related.add(edge.target);
        if (edge.target === hoveredNodeId) related.add(edge.source);
      });
    }
    return {
      graphData: {
        nodes: graph.nodes.map((node) => node.role === "active"
          ? { ...node, fx: 0, fy: 0 }
          : { ...node }),
        links: graph.edges.map((edge) => ({ ...edge }))
      },
      labeledNodeIds: labels,
      relatedNodeIds: related
    };
  }, [graph, hoveredNodeId, mode]);
  const graphPalette = useMemo(() => ({
    background: cssVariable("--graph-canvas", "#000000"),
    activeNode: cssVariable("--signal", "#7C72FF"),
    node: cssVariable("--signal-muted", "#AAA3FF"),
    link: cssVariable("--graph-link", "rgba(124,114,255,0.30)"),
    linkSoft: cssVariable("--graph-link-soft", "rgba(124,114,255,0.13)"),
    linkFocus: cssVariable("--graph-link-focus", "rgba(170,163,255,0.70)"),
    linkHidden: cssVariable("--graph-link-hidden", "rgba(124,114,255,0.025)"),
    arrow: cssVariable("--graph-arrow", "rgba(170,163,255,0.55)"),
    rootFill: cssVariable("--graph-root-fill", "#0A0B12"),
    nodeFill: cssVariable("--graph-node-fill", "#05070B"),
    rootText: cssVariable("--text", "#FFFFFF"),
    nodeText: cssVariable("--graph-node-text", "#E1E1FE"),
    border: cssVariable("--line-bright", "rgba(124,114,255,0.46)")
  }), [theme]);

  useEffect(() => {
    const graphInstance = graphRef.current;
    if (!graphInstance) return;
    const charge = graphInstance.d3Force("charge") as {
      strength?(value: number): unknown;
    } | undefined;
    const link = graphInstance.d3Force("link") as {
      distance?(value: number): unknown;
    } | undefined;
    charge?.strength?.(mode === "modules" ? -900 : -650);
    link?.distance?.(mode === "modules" ? 185 : 135);
    graphInstance.d3ReheatSimulation();
  }, [graphData, mode]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const updateSize = () => setSize({
      width: Math.max(320, element.clientWidth),
      height: Math.max(420, element.clientHeight)
    });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="force-graph-canvas" ref={containerRef}>
      <ForceGraph2D<Graph["nodes"][number], Graph["edges"][number]>
        ref={graphRef}
        width={size.width}
        height={size.height}
        graphData={graphData}
        nodeId="id"
        linkSource="source"
        linkTarget="target"
        backgroundColor={graphPalette.background}
        nodeLabel={(node) => node.label}
        nodeVal={(node) => node.type === "workspace" || node.role === "active" ? 10 : node.type === "module" ? 7 : 3}
        nodeColor={(node) => node.type === "workspace" || node.role === "active" ? graphPalette.activeNode : graphPalette.node}
        linkColor={(link) => {
          if (!hoveredNodeId) return mode === "modules" ? graphPalette.link : graphPalette.linkSoft;
          return linkTouchesNode(link, hoveredNodeId)
            ? graphPalette.linkFocus
            : graphPalette.linkHidden;
        }}
        linkWidth={(link) => {
          if (hoveredNodeId && !linkTouchesNode(link, hoveredNodeId)) return 0.25;
          return Math.min(3, 0.65 + Math.log2(link.weight + 1) * 0.5);
        }}
        linkDirectionalArrowLength={mode === "modules" ? 2.5 : 0}
        linkDirectionalArrowColor={() => graphPalette.arrow}
        warmupTicks={70}
        cooldownTicks={220}
        d3VelocityDecay={0.32}
        minZoom={0.45}
        maxZoom={5}
        enableNodeDrag
        enablePanInteraction
        enableZoomInteraction
        onNodeHover={(node) => setHoveredNodeId(node?.id ?? null)}
        onEngineStop={() => graphRef.current?.zoomToFit(350, 70)}
        nodeCanvasObject={(node, context, globalScale) => {
          if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
          const root = node.type === "workspace" || node.role === "active";
          const focused = hoveredNodeId === null || relatedNodeIds.has(node.id);
          const showLabel = root || node.type === "module" || labeledNodeIds.has(node.id) || relatedNodeIds.has(node.id);
          const x = node.x as number;
          const y = node.y as number;
          context.globalAlpha = focused ? 1 : 0.14;
          if (!showLabel) {
            context.beginPath();
            context.arc(x, y, 3.2 / globalScale, 0, Math.PI * 2);
            context.fillStyle = graphPalette.node;
            context.fill();
            context.globalAlpha = 1;
            return;
          }
          const memberSuffix = node.memberCount && node.type === "module"
            ? ` · ${node.memberCount}`
            : "";
          const label = `${shortenPath(node.label)}${memberSuffix}`;
          const fontSize = Math.max(3.2, (root ? 12 : 9) / globalScale);
          context.font = `${fontSize}px SFMono-Regular, monospace`;
          const textWidth = context.measureText(label).width;
          const paddingX = 5 / globalScale;
          const paddingY = 4 / globalScale;
          const width = textWidth + paddingX * 2;
          const height = fontSize + paddingY * 2;
          context.fillStyle = root ? graphPalette.rootFill : graphPalette.nodeFill;
          context.strokeStyle = root ? graphPalette.activeNode : graphPalette.border;
          context.lineWidth = (root ? 1.4 : 0.8) / globalScale;
          context.fillRect(x - width / 2, y - height / 2, width, height);
          context.strokeRect(x - width / 2, y - height / 2, width, height);
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.fillStyle = root ? graphPalette.rootText : graphPalette.nodeText;
          context.fillText(label, x, y);
          context.globalAlpha = 1;
        }}
      />
    </div>
  );
}

function collapseGraphToModules(graph: Graph): Graph {
  const groupedNodes = new Map<string, Graph["nodes"][number]>();
  const nodeGroups = new Map<string, string>();

  for (const node of graph.nodes) {
    if (node.type !== "file") {
      groupedNodes.set(node.id, { ...node });
      nodeGroups.set(node.id, node.id);
      continue;
    }
    const moduleName = modulePath(node.label);
    const moduleId = `module:${moduleName}`;
    const existing = groupedNodes.get(moduleId);
    groupedNodes.set(moduleId, {
      id: moduleId,
      label: moduleName,
      type: "module",
      role: null,
      memberCount: (existing?.memberCount ?? 0) + 1
    });
    nodeGroups.set(node.id, moduleId);
  }

  const groupedEdges = new Map<string, Graph["edges"][number]>();
  for (const edge of graph.edges) {
    const source = nodeGroups.get(edge.source) ?? edge.source;
    const target = nodeGroups.get(edge.target) ?? edge.target;
    if (source === target || !groupedNodes.has(source) || !groupedNodes.has(target)) continue;
    const key = `${source}\u0000${target}`;
    const existing = groupedEdges.get(key);
    groupedEdges.set(key, {
      source,
      target,
      type: existing?.type ?? edge.type,
      weight: (existing?.weight ?? 0) + Math.max(1, edge.weight)
    });
  }

  const edges = [...groupedEdges.values()];
  const structuralEdges = edges.filter((edge) =>
    groupedNodes.get(edge.source)?.type !== "module" ||
    groupedNodes.get(edge.target)?.type !== "module"
  );
  const moduleEdges = edges
    .filter((edge) =>
      groupedNodes.get(edge.source)?.type === "module" &&
      groupedNodes.get(edge.target)?.type === "module"
    )
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 10);

  return {
    name: graph.name,
    nodes: [...groupedNodes.values()],
    edges: [...structuralEdges, ...moduleEdges]
  };
}

function selectConnectedFiles(graph: Graph, limit: number): Graph {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const structuralNodes = graph.nodes.filter((node) => node.type !== "file");
  const files = graph.nodes
    .filter((node) => node.type === "file")
    .sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0));
  const nodes = [
    ...structuralNodes,
    ...files.slice(0, Math.max(0, limit - structuralNodes.length))
  ];
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    name: graph.name,
    nodes,
    edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
  };
}

function modulePath(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.length <= 1) return "root";
  if (segments[0] === "src" && segments.length > 2) return segments.slice(0, 2).join("/");
  return segments[0] ?? "root";
}

function linkTouchesNode(
  link: Graph["edges"][number],
  nodeId: string
): boolean {
  return graphEndpointId(link.source) === nodeId || graphEndpointId(link.target) === nodeId;
}

function graphEndpointId(endpoint: string | Graph["nodes"][number]): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

function IndexView({
  projectPath,
  scopeData
}: {
  projectPath: string;
  scopeData: PlaygroundScope;
}) {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SymbolItem | null>(null);
  const [indexScope, setIndexScope] = useState<"project" | "workspace">("project");
  const projectQuery = `&project=${encodeURIComponent(projectPath)}`;
  const symbols = useApi<SymbolPage>(
    `/api/index/symbols?page=${page}&limit=20&scope=${indexScope}&query=${encodeURIComponent(query)}${projectQuery}`
  );
  const files = useApi<IndexFiles>(`/api/index/files?scope=${indexScope}${projectQuery}`);
  const logs = useApi<LogFeed>(`/api/logs?limit=80&scope=${indexScope}${projectQuery}`, 3000);

  useEffect(() => {
    setPage(1);
    setQuery("");
    setSelected(null);
  }, [indexScope, projectPath]);
  useEffect(() => setPage(1), [query]);
  if ((symbols.loading && !symbols.data) || (files.loading && !files.data)) {
    return <LoadingPanel label="Reading symbol index" />;
  }
  if (symbols.error || files.error || !symbols.data || !files.data) {
    return <ErrorPanel message={symbols.error ?? files.error} />;
  }
  const data = symbols.data;
  const fileData = files.data;
  const workspaceAvailable = scopeData.mode === "workspace";
  const activeProject = scopeData.projects.find((project) => project.path === projectPath)
    ?? scopeData.projects.find((project) => project.active)
    ?? scopeData.projects[0];
  const scopeLabel = indexScope === "workspace"
    ? `${scopeData.workspaceName ?? "Workspace"} · ${scopeData.projects.length} projects`
    : `${activeProject.name} · ${activeProject.path}`;
  const totalPages = Math.max(1, Math.ceil(data.total / data.limit));

  return (
    <>
      <section className="index-scope-bar panel-wide" aria-label="Index data scope">
        <div>
          <p className="panel-label">DATA SCOPE</p>
          <p title={scopeLabel}>{scopeLabel}</p>
        </div>
        <div className="scope-control" role="tablist" aria-label="Index scope">
          <button
            type="button"
            role="tab"
            aria-selected={indexScope === "project"}
            className={indexScope === "project" ? "is-active" : ""}
            onClick={() => setIndexScope("project")}
          >
            Current project
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={indexScope === "workspace"}
            className={indexScope === "workspace" ? "is-active" : ""}
            disabled={!workspaceAvailable}
            title={workspaceAvailable ? "Aggregate declared workspace projects" : "No infimium.workspace.json found"}
            onClick={() => setIndexScope("workspace")}
          >
            Workspace
          </button>
        </div>
      </section>
      <section className="index-metrics panel-wide" aria-label="Index summary">
        <IndexMetric
          label="INDEXED FILES"
          value={fileData.indexedFiles}
          note={indexScope === "workspace" ? `${scopeData.projects.length} projects` : activeProject.name}
        />
        <IndexMetric label="INDEXED SYMBOLS" value={fileData.indexedSymbols} note="AST-addressable" />
        <IndexMetric
          label="EXCLUDED"
          value={fileData.excludedByInfimiumIgnore}
          note={fileData.ignoreFilePresent ? "via .infimiumignore" : ".infimiumignore not present"}
        />
      </section>
      <section className="index-split panel-wide">
        <article className="panel file-tree-panel">
          <div className="subpanel-heading">
            <div><p className="panel-label">FILE TREE</p><p>{fileData.indexedFiles} indexed files</p></div>
            <Folder size={18} />
          </div>
          <FileTree
            files={fileData.files}
            workspaceScope={indexScope === "workspace"}
            onSelect={(file) => setQuery(
              indexScope === "workspace" ? `${file.projectName} ${file.path}` : file.path
            )}
          />
        </article>
        <article className="panel index-table symbol-table-panel">
        <div className="index-toolbar">
          <div>
            <p className="panel-label">LOCAL SYMBOLS</p>
            <p>{formatNumber(data.total)} symbols</p>
          </div>
          <label className="search-box">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter name, language, or path"
            />
          </label>
        </div>
        <div className="table-row table-head">
          <span>SYMBOL</span><span>LANGUAGE</span><span>FILE</span><span>LINES</span>
        </div>
        {data.items.length > 0 ? data.items.map((symbol) => (
          <button
            className="table-row symbol-row"
            type="button"
            key={symbol.id}
            onClick={() => setSelected(symbol)}
          >
            <span>
              <strong>{symbol.name}</strong>
              <small>{indexScope === "workspace" ? `${symbol.projectName} · ${symbol.type}` : symbol.type}</small>
            </span>
            <span>{symbol.language}</span>
            <span title={`${symbol.projectPath}/${symbol.relativePath}`}>
              {indexScope === "workspace" ? `${symbol.projectName}/${symbol.relativePath}` : symbol.relativePath}
            </span>
            <span>{symbol.lineStart}-{symbol.lineEnd}</span>
          </button>
        )) : (
          <div className="empty-row"><Braces size={20} /><span>No matching indexed symbols</span></div>
        )}
        <div className="pagination">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            <ChevronLeft size={15} />
          </button>
          <span>PAGE {page} / {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
            <ChevronRight size={15} />
          </button>
        </div>
        </article>
      </section>
      <article className="panel panel-wide log-terminal">
        <div className="terminal-header">
          <div>
            <TerminalSquare size={16} />
            <span>{indexScope === "workspace" ? "WORKSPACE INDEX EVENTS" : "PROJECT INDEX EVENTS"}</span>
          </div>
          <span className="live-indicator"><i /> LIVE · {logs.data?.source ?? "waiting"}</span>
        </div>
        <div className="terminal-stream">
          {logs.data?.items.length ? logs.data.items.map((entry) => (
            <div className={`terminal-row${indexScope === "workspace" ? " is-workspace" : ""}`} key={entry.id}>
              <time>{formatLogTime(entry.createdAt)}</time>
              <span className={`log-type type-${entry.type}`}>{entry.type}</span>
              {indexScope === "workspace" ? <span className="log-project">{entry.projectName}</span> : null}
              <p>{entry.message}</p>
            </div>
          )) : <EmptyLine text="Waiting for the first index event" />}
        </div>
      </article>
      {selected ? <SymbolDrawer symbol={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

function IndexMetric({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <article className="index-metric">
      <p className="panel-label">{label}</p>
      <strong>{formatNumber(value)}</strong>
      <span>{note}</span>
    </article>
  );
}

type FileTreeNode = {
  name: string;
  path: string;
  file: IndexFiles["files"][number] | null;
  children: FileTreeNode[];
};

function FileTree({
  files,
  workspaceScope,
  onSelect
}: {
  files: IndexFiles["files"];
  workspaceScope: boolean;
  onSelect(file: IndexFiles["files"][number]): void;
}) {
  const tree = useMemo(() => buildFileTree(files, workspaceScope), [files, workspaceScope]);
  if (tree.length === 0) return <EmptyLine text="No indexed files" />;
  return <div className="file-tree">{tree.map((node) => <FileTreeBranch key={node.path} node={node} depth={0} onSelect={onSelect} />)}</div>;
}

function FileTreeBranch({
  node,
  depth,
  onSelect
}: {
  node: FileTreeNode;
  depth: number;
  onSelect(file: IndexFiles["files"][number]): void;
}) {
  if (node.file) {
    return (
      <button className="tree-file" type="button" onClick={() => node.file && onSelect(node.file)}>
        <FileCode2 size={13} />
        <span>{node.name}</span>
        <em>{node.file.symbolCount}</em>
      </button>
    );
  }
  return (
    <details className="tree-directory" open={depth < 1}>
      <summary><Folder size={13} /><span>{node.name}</span><em>{node.children.length}</em></summary>
      <div>{node.children.map((child) => <FileTreeBranch key={child.path} node={child} depth={depth + 1} onSelect={onSelect} />)}</div>
    </details>
  );
}

function buildFileTree(files: IndexFiles["files"], workspaceScope: boolean): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  for (const file of files) {
    const parts = [
      ...(workspaceScope ? [file.projectName] : []),
      ...file.path.split("/").filter(Boolean)
    ];
    let siblings = roots;
    let currentPath = "";
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = index === parts.length - 1;
      let node = siblings.find((candidate) => candidate.name === part);
      if (!node) {
        node = { name: part, path: currentPath, file: isFile ? file : null, children: [] };
        siblings.push(node);
      }
      siblings = node.children;
    });
  }
  const sort = (nodes: FileTreeNode[]): FileTreeNode[] => nodes
    .sort((left, right) => {
      if (Boolean(left.file) !== Boolean(right.file)) return left.file ? 1 : -1;
      return left.name.localeCompare(right.name);
    })
    .map((node) => ({ ...node, children: sort(node.children) }));
  return sort(roots);
}

function SymbolDrawer({ symbol, onClose }: { symbol: SymbolItem; onClose(): void }) {
  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="symbol-drawer" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="panel-label">SYMBOL DETAIL</p>
            <h2>{symbol.name}</h2>
            <p>{symbol.projectName} · {symbol.relativePath}:{symbol.lineStart}-{symbol.lineEnd}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close symbol detail"><X size={18} /></button>
        </header>
        <section>
          <p className="code-label"><span>AST SKELETON</span><em>initial retrieval</em></p>
          <pre className="skeleton-code"><code>{symbol.skeleton}</code></pre>
        </section>
        <section>
          <p className="code-label"><span>FULL IMPLEMENTATION</span><em>expand_symbol</em></p>
          <pre><code>{symbol.fullImplementation}</code></pre>
        </section>
      </aside>
    </div>
  );
}

function EconomicsView({ projectPath }: { projectPath: string }) {
  const metrics = useApi<Metrics>(withProject("/api/metrics", projectPath));
  if (metrics.loading) return <LoadingPanel label="Calculating token economics" />;
  if (metrics.error || !metrics.data) return <ErrorPanel message={metrics.error} />;
  const data = metrics.data;
  const payloadReduction = data.averageFullTextTokens > 0
    ? ((1 - data.averageSkeletonTokens / data.averageFullTextTokens) * 100).toFixed(1)
    : "0.0";
  const observedLabel = data.observedAverageFullTextTokens > 0
    ? `${formatNumber(data.observedAverageFullTextTokens)} -> ${formatNumber(data.observedAverageSkeletonTokens)}`
    : "--";

  return (
    <>
      <article className="panel panel-wide payload-proof">
        <div className="payload-proof-copy">
          <p className="panel-label">REFERENCE PAYLOAD</p>
          <p>Infimium sends a symbol skeleton first. Full code stays local until `expand_symbol` is requested.</p>
        </div>
        <div className="payload-equation" aria-label={`${data.averageFullTextTokens} tokens reduced to ${data.averageSkeletonTokens} tokens per symbol`}>
          <div>
            <span>FULL TEXT</span>
            <strong>~{formatNumber(data.averageFullTextTokens)}</strong>
            <em>tokens</em>
          </div>
          <ArrowRight size={28} strokeWidth={1.4} />
          <div className="is-ast">
            <span>AST SKELETON</span>
            <strong>~{formatNumber(data.averageSkeletonTokens)}</strong>
            <em>tokens</em>
          </div>
          <div className="payload-reduction">
            <strong>{payloadReduction}%</strong>
            <span>smaller initial payload</span>
          </div>
        </div>
      </article>
      <section className="panel-wide economics-summary" aria-label="Repository token summary">
        <div>
          <span>PROJECT SYMBOLS</span>
          <strong>{formatNumber(data.symbolCount)}</strong>
          <small>indexed locally</small>
        </div>
        <div>
          <span>TOKENS SAVED</span>
          <strong>{compactNumber(data.totalTokensSaved)}</strong>
          <small>project estimate</small>
        </div>
        <div>
          <span>USD SAVED</span>
          <strong>{formatCurrency(data.estimatedUsdSaved)}</strong>
          <small>at ${data.usdPerMillionInputTokens}/M input tokens</small>
        </div>
        <div>
          <span>OBSERVED AVG</span>
          <strong>{observedLabel}</strong>
          <small>full &rarr; skeleton tokens</small>
        </div>
      </section>
      <TokenOptimizationSimulator metrics={data} />
    </>
  );
}

const simulatorInitialState = { contextWindow: 128000, maxRetrievals: 10 } as const;

const retrievalStrategies: Array<{
  label: RetrievalStrategy;
  tokensPerSymbol: number;
  tone: "danger" | "warning" | "success";
  shortLabel: string;
  description: string;
}> = [
  {
    label: "Full Implementation Text",
    tokensPerSymbol: 1460,
    tone: "danger",
    shortLabel: "Full text",
    description: "Send complete functions immediately."
  },
  {
    label: "Semantic Chunks",
    tokensPerSymbol: 220,
    tone: "warning",
    shortLabel: "Chunks",
    description: "Send text chunks from matching files."
  },
  {
    label: "Infimium AST Skeletons",
    tokensPerSymbol: 8,
    tone: "success",
    shortLabel: "AST-first",
    description: "Send signatures first; expand code only when needed."
  }
];

function TokenOptimizationSimulator({ metrics }: { metrics: Metrics }) {
  const [retrievals, setRetrievals] = useState(3);
  const [strategy, setStrategy] = useState<RetrievalStrategy>("Infimium AST Skeletons");

  const selected = retrievalStrategies.find((item) => item.label === strategy) ?? retrievalStrategies[2];
  const fullText = retrievalStrategies[0];
  const projectSymbols = Math.max(1, metrics.symbolCount);
  const symbolsPerRetrieval = Math.max(1, Math.ceil(projectSymbols / 80));
  const tokensBurned = Math.round(retrievals * symbolsPerRetrieval * selected.tokensPerSymbol);
  const fullTextBaseline = Math.round(retrievals * symbolsPerRetrieval * fullText.tokensPerSymbol);
  const contextPercent = simulatorInitialState.contextWindow > 0
    ? (tokensBurned / simulatorInitialState.contextWindow) * 100
    : 0;
  const fullTextCost = (fullTextBaseline / 1_000_000) * metrics.usdPerMillionInputTokens;
  const selectedCost = (tokensBurned / 1_000_000) * metrics.usdPerMillionInputTokens;
  const costSaved = Math.max(0, fullTextCost - selectedCost);
  const overLimit = tokensBurned > simulatorInitialState.contextWindow;
  const selectedPercent = Math.min(100, (tokensBurned / Math.max(fullTextBaseline, 1)) * 100);
  const savedPercent = fullTextBaseline > 0
    ? Math.round((1 - tokensBurned / fullTextBaseline) * 1000) / 10
    : 0;

  return (
    <article className="panel panel-wide simulator-panel">
      <div className="simulator-heading">
        <div>
          <p className="panel-label">QUICK WHAT-IF</p>
          <h2>How much context does the agent spend?</h2>
          <p>
            Pick how many times the agent searches this project. Compare full-code retrieval against Infimium's AST-first path.
          </p>
        </div>
        <div className="simulator-savings-card" aria-label={`Project saved ${formatCurrency(metrics.estimatedUsdSaved)}`}>
          <span>Project saved</span>
          <strong>{formatCurrency(metrics.estimatedUsdSaved)}</strong>
          <small>{formatCurrency(costSaved)} in this what-if</small>
        </div>
      </div>

      <div className="simulator-stats" aria-label="Token spend summary">
        <div>
          <span>Selected strategy</span>
          <strong>{selected.shortLabel}</strong>
        </div>
        <div>
          <span>Context used</span>
          <strong>{compactNumber(tokensBurned)}</strong>
          <small>{Math.min(999, Math.round(contextPercent))}% of 128K</small>
        </div>
        <div>
          <span>Saved vs full text</span>
          <strong>{savedPercent}%</strong>
          <small>{formatCurrency(costSaved)}</small>
        </div>
      </div>

      <div className="simulator-bars" aria-label="Full text versus selected strategy token use">
        <div className="simulator-bar-row">
          <span>Full text</span>
          <div><i style={{ width: "100%" }} /></div>
          <strong>{compactNumber(fullTextBaseline)}</strong>
        </div>
        <div className={`simulator-bar-row is-${overLimit ? "danger" : selected.tone}`}>
          <span>{selected.shortLabel}</span>
          <div><i style={{ width: `${selectedPercent}%` }} /></div>
          <strong>{compactNumber(tokensBurned)}</strong>
        </div>
      </div>

      <div className="simulator-note">
        <p>{selected.description}</p>
        <span>{overLimit ? "Over context limit" : "Inside context limit"}</span>
      </div>

      <div className="simulator-controls" aria-label="Token optimization simulator controls">
        <label>
          <span>Agent searches</span>
          <div className="simulator-range-row">
            <input
              type="range"
              min="1"
              max={simulatorInitialState.maxRetrievals}
              value={retrievals}
              onChange={(event) => setRetrievals(Number(event.target.value))}
            />
            <strong>{retrievals}</strong>
          </div>
        </label>

        <div className="strategy-buttons" role="tablist" aria-label="Retrieval strategy">
          <span>Strategy</span>
          <div>
            {retrievalStrategies.map((item) => (
              <button
                key={item.label}
                type="button"
                role="tab"
                aria-selected={strategy === item.label}
                className={strategy === item.label ? "is-active" : ""}
                onClick={() => setStrategy(item.label)}
              >
                {item.shortLabel}
              </button>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}

function HealthBadge({
  label,
  online,
  readyLabel = false
}: {
  label: string;
  online: boolean;
  readyLabel?: boolean;
}) {
  return (
    <div className="runtime-health">
      <span className={`health-dot${online ? "" : " is-offline"}`} />
      <span>{label} {online ? (readyLabel ? "READY" : "ONLINE") : "OFFLINE"}</span>
    </div>
  );
}

function MetricPanel({
  icon: Icon,
  label,
  value,
  note
}: {
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <article className="panel metric-panel">
      <Icon size={19} strokeWidth={1.7} />
      <p className="panel-label">{label}</p>
      <p className="metric-value">{value}</p>
      <p className="metric-note">{note}</p>
    </article>
  );
}

function LoadingPanel({ label }: { label: string }) {
  return <article className="panel panel-full state-panel"><span className="loading-pulse" /><p>{label}...</p></article>;
}

function ErrorPanel({ message }: { message: string | null }) {
  return <article className="panel panel-full state-panel is-error"><p>Could not read local state.</p><span>{message ?? "Unknown local API error"}</span></article>;
}

function EmptyLine({ text }: { text: string }) {
  return <p className="terminal-empty">$ {text.toLowerCase().replaceAll(" ", "_")}</p>;
}

function withProject(path: string, projectPath: string): string {
  if (!projectPath) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}project=${encodeURIComponent(projectPath)}`;
}

function useApi<T>(
  path: string,
  refreshMs?: number
): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      fetch(path, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<T>;
        })
        .then((value) => {
          setData(value);
          setError(null);
        })
        .catch((caught: unknown) => {
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    };
    setLoading(true);
    load();
    const interval = refreshMs ? window.setInterval(load, refreshMs) : null;
    return () => {
      controller.abort();
      if (interval !== null) window.clearInterval(interval);
    };
  }, [path, refreshMs]);

  return { data, loading, error };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatCurrency(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatLogTime(value: string | null): string {
  if (!value) return "--:--:--";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "--:--:--"
    : date.toLocaleTimeString(undefined, { hour12: false });
}

function shortenPath(value: string): string {
  const parts = value.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : value;
}
