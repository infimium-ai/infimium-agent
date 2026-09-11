import { createHash } from "node:crypto";
import type { MemoryCheckpoint } from "./project-memory.js";

export function buildMemoryGraph(checkpoints: MemoryCheckpoint[]) {
  const nodes = new Map<string, { id: string; kind: string; label: string; createdAt?: number }>();
  const edges: Array<{ from: string; to: string; relation: string }> = [];
  const visible = new Set(checkpoints.map((entry) => entry.id));
  const entityId = (project: string, kind: string, value: string) =>
    `${kind}:${createHash("sha256").update(JSON.stringify([project, value])).digest("hex").slice(0, 16)}`;
  for (const entry of checkpoints) {
    nodes.set(entry.id, { id: entry.id, kind: "episode", label: entry.summary, createdAt: entry.createdAt });
    if (entry.previousId && visible.has(entry.previousId)) {
      edges.push({ from: entry.previousId, to: entry.id, relation: "followed_by" });
    }
    for (const [kind, values, relation] of [
      ["file", entry.files, "involves"],
      ["task", entry.task ? [entry.task] : [], "records"],
      ["handoff", entry.handoff ? [entry.handoff] : [], "hands_off"]
    ] as const) {
      for (const value of values) {
        const id = entityId(entry.projectPath, kind, value);
        nodes.set(id, { id, kind, label: value });
        edges.push({ from: entry.id, to: id, relation });
      }
    }
  }
  return { nodes: [...nodes.values()], edges };
}
