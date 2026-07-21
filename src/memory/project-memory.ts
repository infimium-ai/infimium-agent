import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { dataPath } from "../paths.js";

const require = createRequire(import.meta.url);
const DEFAULT_MEMORY_LIMIT = 8;

type Database = import("node:sqlite").DatabaseSync;
type StatementSync = import("node:sqlite").StatementSync;

export type ProjectMemoryEventType =
  | "note"
  | "progress"
  | "decision"
  | "blocker"
  | "index"
  | "plan";

export type ProjectMemoryEvent = {
  projectPath: string;
  eventType: ProjectMemoryEventType;
  summary: string;
  details: string | null;
  createdAt: number;
};

export type ProjectState = {
  projectPath: string;
  currentTask: string | null;
  lastPlanPath: string | null;
  lastNote: string | null;
  updatedAt: number | null;
};

export type ProjectResumeContext = {
  projectPath: string;
  state: ProjectState;
  recentEvents: ProjectMemoryEvent[];
};

export type ProjectContextSnapshotRecord = {
  projectPath: string;
  filePath: string;
  snapshotText: string;
  format: "yaml" | "json";
  updatedAt: number;
  activateProject?: boolean;
};

export type ProjectOverviewRecord = {
  projectId: string;
  projectPath: string;
  overviewJson: string;
  updatedAt: number;
};

export type RememberInput = {
  projectPath?: string;
  eventType?: ProjectMemoryEventType;
  summary: string;
  details?: string | null;
  currentTask?: string | null;
  lastPlanPath?: string | null;
  createdAt?: number;
};

type SqliteRow = Record<string, unknown>;
type EventRow = {
  project_path?: unknown;
  event_type?: unknown;
  summary?: unknown;
  details?: unknown;
  created_at?: unknown;
};
type StateRow = {
  project_path?: unknown;
  current_task?: unknown;
  last_plan_path?: unknown;
  last_note?: unknown;
  updated_at?: unknown;
};
type ActiveProjectRow = {
  project_path?: unknown;
};

export class ProjectMemoryStore {
  private readonly db: Database;
  private readonly dbPath: string;

  constructor(dbPath: string = dataPath("infimium.db")) {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const resolvedDbPath = resolve(dbPath);
    mkdirSync(dirname(resolvedDbPath), { recursive: true });
    this.dbPath = resolvedDbPath;
    this.db = new DatabaseSync(resolvedDbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 30000;");
    this.ensureSchema();
  }

  remember(input: RememberInput): ProjectMemoryEvent {
    const projectPath = resolve(input.projectPath ?? process.cwd());
    const summary = input.summary.trim();
    if (!summary) {
      throw new Error("Memory summary cannot be empty");
    }

    const eventType = input.eventType ?? "note";
    const createdAt = input.createdAt ?? Date.now();
    const details = normalizeOptionalText(input.details);

    this.db
      .prepare(
        `INSERT INTO project_changes
          (project_path, event_type, summary, details, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(projectPath, eventType, summary, details, createdAt);

    this.upsertState({
      projectPath,
      currentTask: normalizeOptionalText(input.currentTask),
      inferCurrentTask: eventType !== "index" && eventType !== "plan",
      lastPlanPath: normalizeOptionalText(input.lastPlanPath),
      lastNote: summary,
      updatedAt: createdAt
    });
    this.setActiveProjectPath(projectPath, createdAt);

    return {
      projectPath,
      eventType,
      summary,
      details,
      createdAt
    };
  }

  getResumeContext(projectPath: string = process.cwd(), limit: number = DEFAULT_MEMORY_LIMIT): ProjectResumeContext {
    const resolvedProjectPath = resolve(projectPath);
    return {
      projectPath: resolvedProjectPath,
      state: this.getProjectState(resolvedProjectPath),
      recentEvents: this.getRecentEvents(resolvedProjectPath, limit)
    };
  }

  setActiveProjectPath(projectPath: string, updatedAt: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO active_project (id, project_path, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          project_path = excluded.project_path,
          updated_at = excluded.updated_at`
      )
      .run(resolve(projectPath), updatedAt);
  }

  getActiveProjectPath(): string | null {
    const row = this.db
      .prepare("SELECT project_path FROM active_project WHERE id = 1")
      .get() as ActiveProjectRow | undefined;

    return readString(row?.project_path);
  }

  getWatchedProjectCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT project_path) AS count
         FROM (
           SELECT project_path FROM project_changes
           UNION
           SELECT project_path FROM project_state
           UNION
           SELECT project_path FROM context_snapshots
           UNION
           SELECT project_path FROM project_overviews
           UNION
           SELECT project_path FROM active_project
         )`
      )
      .get() as SqliteRow | undefined;

    return readNumber(row, "count");
  }

  getKnownProjectPaths(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT project_path
         FROM (
           SELECT project_path FROM project_changes
           UNION
           SELECT project_path FROM project_state
           UNION
           SELECT project_path FROM context_snapshots
           UNION
           SELECT project_path FROM project_overviews
           UNION
           SELECT project_path FROM active_project
         )
         WHERE project_path IS NOT NULL
         ORDER BY project_path`
      )
      .all() as Array<{ project_path?: unknown }>;

    return rows
      .map((row) => readString(row.project_path))
      .filter((projectPath): projectPath is string => projectPath !== null);
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  saveContextSnapshot(input: ProjectContextSnapshotRecord): void {
    const projectPath = resolve(input.projectPath);
    const updatedAt = input.updatedAt;

    this.db
      .prepare(
        `INSERT INTO context_snapshots
          (project_path, file_path, snapshot_json, snapshot_format, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_path) DO UPDATE SET
          file_path = excluded.file_path,
          snapshot_json = excluded.snapshot_json,
          snapshot_format = excluded.snapshot_format,
          updated_at = excluded.updated_at`
      )
      .run(projectPath, input.filePath, input.snapshotText, input.format, updatedAt);

    this.db
      .prepare(
        `INSERT INTO context_snapshot_history
          (project_path, file_path, snapshot_json, snapshot_format, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(projectPath, input.filePath, input.snapshotText, input.format, updatedAt);

    if (input.activateProject ?? true) {
      this.setActiveProjectPath(projectPath, updatedAt);
    }
  }

  getLatestContextSnapshot(projectPath: string = process.cwd()): ProjectContextSnapshotRecord | null {
    const row = this.db
      .prepare(
        `SELECT project_path, file_path, snapshot_json, snapshot_format, updated_at
         FROM context_snapshots
         WHERE project_path = ?`
      )
      .get(resolve(projectPath)) as {
        project_path?: unknown;
        file_path?: unknown;
        snapshot_json?: unknown;
        snapshot_format?: unknown;
        updated_at?: unknown;
      } | undefined;

    const snapshotText = readString(row?.snapshot_json);
    const filePath = readString(row?.file_path);
    if (!snapshotText || !filePath) {
      return null;
    }

    return {
      projectPath: readString(row?.project_path) ?? resolve(projectPath),
      filePath,
      snapshotText,
      format: row?.snapshot_format === "json" ? "json" : "yaml",
      updatedAt: readNullableNumber(row, "updated_at") ?? 0
    };
  }

  saveProjectOverview(input: ProjectOverviewRecord): void {
    this.db
      .prepare(
        `INSERT INTO project_overviews
          (project_id, project_path, overview_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
          project_path = excluded.project_path,
          overview_json = excluded.overview_json,
          updated_at = excluded.updated_at`
      )
      .run(input.projectId, resolve(input.projectPath), input.overviewJson, input.updatedAt);
  }

  getProjectOverview(projectPath: string): ProjectOverviewRecord | null {
    const row = this.db
      .prepare(
        `SELECT project_id, project_path, overview_json, updated_at
         FROM project_overviews
         WHERE project_path = ?`
      )
      .get(resolve(projectPath)) as {
        project_id?: unknown;
        project_path?: unknown;
        overview_json?: unknown;
        updated_at?: unknown;
      } | undefined;
    const projectId = readString(row?.project_id);
    const storedPath = readString(row?.project_path);
    const overviewJson = readString(row?.overview_json);
    const updatedAt = readNullableNumber(row, "updated_at");
    if (!projectId || !storedPath || !overviewJson || updatedAt === null) {
      return null;
    }
    return { projectId, projectPath: storedPath, overviewJson, updatedAt };
  }

  close(): void {
    this.db.close();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_changes (
        project_path TEXT NOT NULL,
        event_type TEXT,
        summary TEXT,
        details TEXT,
        created_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS project_state (
        project_path TEXT PRIMARY KEY,
        current_task TEXT,
        last_plan_path TEXT,
        last_note TEXT,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS context_snapshots (
        project_path TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        snapshot_format TEXT NOT NULL DEFAULT 'json',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS context_snapshot_history (
        project_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        snapshot_format TEXT NOT NULL DEFAULT 'json',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS active_project (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        project_path TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_overviews (
        project_id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL UNIQUE,
        overview_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_project_changes_project_time
        ON project_changes(project_path, created_at);

      CREATE INDEX IF NOT EXISTS idx_context_snapshot_history_project_time
        ON context_snapshot_history(project_path, updated_at);
    `);

    this.ensureColumn("project_changes", "event_type", "TEXT");
    this.ensureColumn("project_changes", "summary", "TEXT");
    this.ensureColumn("project_changes", "details", "TEXT");
    this.ensureColumn("project_changes", "created_at", "INTEGER");
    this.ensureColumn("context_snapshots", "snapshot_format", "TEXT NOT NULL DEFAULT 'json'");
    this.ensureColumn("context_snapshot_history", "snapshot_format", "TEXT NOT NULL DEFAULT 'json'");
  }

  private ensureColumn(tableName: string, columnName: string, columnType: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name?: unknown;
    }>;
    const exists = rows.some((row) => row.name === columnName);

    if (!exists) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
    }
  }

  private upsertState(input: {
    projectPath: string;
    currentTask: string | null;
    inferCurrentTask: boolean;
    lastPlanPath: string | null;
    lastNote: string;
    updatedAt: number;
  }): void {
    const existing = this.getProjectState(input.projectPath);
    const currentTask =
      input.currentTask ??
      existing.currentTask ??
      (input.inferCurrentTask ? input.lastNote : null);
    const lastPlanPath = input.lastPlanPath ?? existing.lastPlanPath;

    this.db
      .prepare(
        `INSERT INTO project_state
          (project_path, current_task, last_plan_path, last_note, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_path) DO UPDATE SET
          current_task = excluded.current_task,
          last_plan_path = excluded.last_plan_path,
          last_note = excluded.last_note,
          updated_at = excluded.updated_at`
      )
      .run(input.projectPath, currentTask, lastPlanPath, input.lastNote, input.updatedAt);
  }

  private getProjectState(projectPath: string): ProjectState {
    const row = this.db
      .prepare(
        `SELECT project_path, current_task, last_plan_path, last_note, updated_at
         FROM project_state
         WHERE project_path = ?`
      )
      .get(projectPath) as StateRow | undefined;

    return {
      projectPath,
      currentTask: readString(row?.current_task),
      lastPlanPath: readString(row?.last_plan_path),
      lastNote: readString(row?.last_note),
      updatedAt: readNullableNumber(row, "updated_at")
    };
  }

  private getRecentEvents(projectPath: string, limit: number): ProjectMemoryEvent[] {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const statement = this.db.prepare(
      `SELECT project_path, event_type, summary, details, created_at
       FROM project_changes
       WHERE project_path = ?
       ORDER BY COALESCE(created_at, 0) DESC, rowid DESC
       LIMIT ?`
    ) as StatementSync;

    const rows = statement.all(projectPath, safeLimit) as EventRow[];
    return rows.map(readEventRow);
  }
}

export function formatResumeContext(context: ProjectResumeContext, nowMs: number = Date.now()): string {
  const state = context.state;
  const events = context.recentEvents.map(
    (event) =>
      `- ${event.eventType}: ${event.summary} (${formatRelativeTime(event.createdAt, nowMs)})`
  );

  return [
    "Infimium resume context",
    `Project: ${context.projectPath}`,
    `Current task: ${state.currentTask ?? "Not set"}`,
    `Last note: ${state.lastNote ?? "None"}`,
    `Last plan: ${state.lastPlanPath ?? "None"}`,
    `Last updated: ${state.updatedAt ? formatRelativeTime(state.updatedAt, nowMs) : "never"}`,
    "",
    "Recent memory:",
    events.length > 0 ? events.join("\n") : "No memory recorded yet.",
    "",
    "Use this context before searching code or making changes."
  ].join("\n");
}

function readEventRow(row: EventRow): ProjectMemoryEvent {
  const eventType = readEventType(row.event_type);
  const summary = readString(row.summary) ?? "(no summary)";

  return {
    projectPath: readString(row.project_path) ?? "",
    eventType,
    summary,
    details: readString(row.details),
    createdAt: readNullableNumber(row, "created_at") ?? 0
  };
}

function readEventType(value: unknown): ProjectMemoryEventType {
  if (
    value === "note" ||
    value === "progress" ||
    value === "decision" ||
    value === "blocker" ||
    value === "index" ||
    value === "plan"
  ) {
    return value;
  }

  return "note";
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(row: SqliteRow | undefined, key: string): number {
  return readNullableNumber(row, key) ?? 0;
}

function readNullableNumber(row: SqliteRow | undefined, key: string): number | null {
  const value = row?.[key];
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  return null;
}

function formatRelativeTime(timestampMs: number, nowMs: number): string {
  if (!timestampMs) {
    return "unknown time";
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (elapsedSeconds < 60) {
    return elapsedSeconds === 1 ? "1 second ago" : `${elapsedSeconds} seconds ago`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return elapsedMinutes === 1 ? "1 minute ago" : `${elapsedMinutes} minutes ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return elapsedHours === 1 ? "1 hour ago" : `${elapsedHours} hours ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return elapsedDays === 1 ? "1 day ago" : `${elapsedDays} days ago`;
}
