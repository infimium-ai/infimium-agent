import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { dataPath } from "../paths.js";

const require = createRequire(import.meta.url);
const DEFAULT_MEMORY_LIMIT = 8;
const CURRENT_MEMORY_SCHEMA_VERSION = 1;

type Database = import("node:sqlite").DatabaseSync;
type StatementSync = import("node:sqlite").StatementSync;
type SqliteRow = Record<string, unknown>;

export type ProjectMemoryEventType =
  | "note"
  | "progress"
  | "decision"
  | "blocker"
  | "index"
  | "plan";

export type MemoryLedgerCategory = "decision" | "rule" | "quirk" | "blocker";
export type MemorySessionStatus = "active" | "completed" | "abandoned";

export type ProjectMemoryEvent = {
  projectPath: string;
  eventType: ProjectMemoryEventType;
  summary: string;
  details: string | null;
  createdAt: number;
};

export type MemorySession = {
  id: string;
  projectPath: string;
  task: string | null;
  status: MemorySessionStatus;
  startedAt: number;
  completedAt: number | null;
  compactedAt: number | null;
};

export type MemoryScratchpadEvent = ProjectMemoryEvent & {
  id: number;
  sessionId: string;
  compactedAt: number | null;
};

export type MemoryArchiveEntry = {
  id: number;
  sessionId: string;
  projectPath: string;
  milestone: string;
  summary: string;
  relevantFiles: string[];
  unresolvedBlockers: string[];
  completedAt: number;
};

export type MemoryLedgerEntry = {
  id: number;
  projectPath: string;
  category: MemoryLedgerCategory;
  key: string;
  value: string;
  status: "active" | "superseded";
  sourceSessionId: string | null;
  confidence: number | null;
  createdAt: number;
  updatedAt: number;
  supersededBy: number | null;
};

export type DurableMemory = {
  category: MemoryLedgerCategory;
  key: string;
  value: string;
  confidence: number;
};

export type ProjectState = {
  projectPath: string;
  currentTask: string | null;
  lastPlanPath: string | null;
  lastNote: string | null;
  activeSessionId: string | null;
  updatedAt: number | null;
};

export type ProjectResumeContext = {
  projectPath: string;
  state: ProjectState;
  activeSession: MemorySession | null;
  activeScratchpad: MemoryScratchpadEvent[];
  recentArchives: MemoryArchiveEntry[];
  semanticLedger: MemoryLedgerEntry[];
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

export type CompleteSessionInput = {
  projectPath: string;
  sessionId: string;
  milestone: string;
  summary: string;
  durableMemories: DurableMemory[];
  unresolvedBlockers: string[];
  relevantFiles: string[];
  completedAt?: number;
};

export type MemorySearchResult = {
  source: "ledger" | "archive";
  category: string;
  title: string;
  summary: string;
  createdAt: number;
};

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
  active_session_id?: unknown;
  updated_at?: unknown;
};
type ActiveProjectRow = { project_path?: unknown };

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
    this.pruneLegacyEvents(projectPath);

    let activeSessionId: string | null = null;
    if (eventType !== "index") {
      const session = this.getOrStartSession(
        projectPath,
        normalizeOptionalText(input.currentTask) ?? summary,
        createdAt
      );
      activeSessionId = session.id;
      this.db
        .prepare(
          `INSERT INTO memory_scratchpad
            (session_id, project_path, event_type, summary, details, created_at, compacted_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(session.id, projectPath, eventType, summary, details, createdAt);
    }

    const existingState = this.getProjectState(projectPath);
    this.upsertState({
      projectPath,
      currentTask: normalizeOptionalText(input.currentTask),
      inferCurrentTask: eventType !== "index" && eventType !== "plan",
      lastPlanPath: normalizeOptionalText(input.lastPlanPath),
      lastNote: eventType === "index" ? existingState.lastNote ?? summary : summary,
      activeSessionId,
      updatedAt: createdAt
    });
    this.setActiveProjectPath(projectPath, createdAt);

    return { projectPath, eventType, summary, details, createdAt };
  }

  startSession(projectPath: string, task?: string | null, startedAt: number = Date.now()): MemorySession {
    const resolvedProjectPath = resolve(projectPath);
    const existing = this.getActiveSession(resolvedProjectPath);
    if (existing) {
      return existing;
    }

    const session: MemorySession = {
      id: randomUUID(),
      projectPath: resolvedProjectPath,
      task: normalizeOptionalText(task),
      status: "active",
      startedAt,
      completedAt: null,
      compactedAt: null
    };
    try {
      this.db
        .prepare(
          `INSERT INTO memory_sessions
            (id, project_path, task, status, started_at, completed_at, compacted_at)
           VALUES (?, ?, ?, 'active', ?, NULL, NULL)`
        )
        .run(session.id, session.projectPath, session.task, session.startedAt);
    } catch (error: unknown) {
      const concurrent = this.getActiveSession(resolvedProjectPath);
      if (concurrent) return concurrent;
      throw error;
    }
    this.setStateActiveSession(resolvedProjectPath, session.id, session.task, startedAt);
    this.setActiveProjectPath(resolvedProjectPath, startedAt);
    return session;
  }

  getActiveSession(projectPath: string = process.cwd()): MemorySession | null {
    const row = this.db
      .prepare(
        `SELECT id, project_path, task, status, started_at, completed_at, compacted_at
         FROM memory_sessions
         WHERE project_path = ? AND status = 'active'
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get(resolve(projectPath)) as SqliteRow | undefined;
    return row ? readSessionRow(row) : null;
  }

  getScratchpadEvents(sessionId: string, limit: number = 50): MemoryScratchpadEvent[] {
    const safeLimit = clampLimit(limit, 200);
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT id, session_id, project_path, event_type, summary, details, created_at, compacted_at
           FROM memory_scratchpad
           WHERE session_id = ? AND compacted_at IS NULL
           ORDER BY created_at DESC, id DESC
           LIMIT ?
         ) ORDER BY created_at ASC, id ASC`
      )
      .all(sessionId, safeLimit) as SqliteRow[];
    return rows.map(readScratchpadRow);
  }

  completeSession(input: CompleteSessionInput): MemoryArchiveEntry {
    const projectPath = resolve(input.projectPath);
    const completedAt = input.completedAt ?? Date.now();
    const existing = this.getArchiveBySession(input.sessionId);
    if (existing) {
      return existing;
    }

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const insert = this.db
        .prepare(
          `INSERT INTO memory_archive
            (session_id, project_path, milestone, summary, files_json, blockers_json, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.sessionId,
          projectPath,
          input.milestone.trim(),
          input.summary.trim(),
          JSON.stringify(input.relevantFiles.slice(0, 20)),
          JSON.stringify(input.unresolvedBlockers.slice(0, 10)),
          completedAt
        );
      const archiveId = Number(insert.lastInsertRowid);

      for (const memory of input.durableMemories.slice(0, 20)) {
        this.upsertLedgerEntry(projectPath, input.sessionId, memory, completedAt);
      }

      this.db
        .prepare("UPDATE memory_scratchpad SET compacted_at = ? WHERE session_id = ?")
        .run(completedAt, input.sessionId);
      this.db
        .prepare(
          `UPDATE memory_sessions
           SET status = 'completed', completed_at = ?, compacted_at = ?
           WHERE id = ? AND project_path = ?`
        )
        .run(completedAt, completedAt, input.sessionId, projectPath);
      this.db
        .prepare(
          `UPDATE project_state
           SET current_task = NULL, active_session_id = NULL, last_note = ?, updated_at = ?
           WHERE project_path = ?`
        )
        .run(input.summary.trim(), completedAt, projectPath);
      this.db.exec("COMMIT;");
      this.pruneCompactedScratchpad();

      return {
        id: archiveId,
        sessionId: input.sessionId,
        projectPath,
        milestone: input.milestone.trim(),
        summary: input.summary.trim(),
        relevantFiles: input.relevantFiles.slice(0, 20),
        unresolvedBlockers: input.unresolvedBlockers.slice(0, 10),
        completedAt
      };
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
      const concurrent = this.getArchiveBySession(input.sessionId);
      if (concurrent) return concurrent;
      throw error;
    }
  }

  getRecentArchives(projectPath: string, limit: number = 3): MemoryArchiveEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, project_path, milestone, summary, files_json, blockers_json, completed_at
         FROM memory_archive
         WHERE project_path = ?
         ORDER BY completed_at DESC, id DESC
         LIMIT ?`
      )
      .all(resolve(projectPath), clampLimit(limit, 20)) as SqliteRow[];
    return rows.map(readArchiveRow);
  }

  pruneCompactedScratchpad(
    retentionMs: number = 7 * 24 * 60 * 60 * 1_000,
    now: number = Date.now()
  ): number {
    const safeRetention = Math.max(0, retentionMs);
    const result = this.db
      .prepare(
        `DELETE FROM memory_scratchpad
         WHERE compacted_at IS NOT NULL AND compacted_at < ?`
      )
      .run(now - safeRetention);
    return Number(result.changes);
  }

  getRelevantLedger(projectPath: string, query: string = "", limit: number = 5): MemoryLedgerEntry[] {
    const resolvedProjectPath = resolve(projectPath);
    const terms = tokenizeSearch(query);
    const rows = this.db
      .prepare(
        `SELECT id, project_path, category, memory_key, value, status, source_session_id,
                confidence, created_at, updated_at, superseded_by
         FROM memory_ledger
         WHERE project_path = ? AND status = 'active'
         ORDER BY updated_at DESC, id DESC`
      )
      .all(resolvedProjectPath) as SqliteRow[];
    const entries = rows.map(readLedgerRow);
    const ranked = terms.length === 0
      ? entries
      : entries
          .map((entry) => ({ entry, score: scoreLedgerEntry(entry, terms) }))
          .filter((item) => item.score > 0)
          .sort((left, right) => right.score - left.score || right.entry.updatedAt - left.entry.updatedAt)
          .map((item) => item.entry);
    return ranked.slice(0, clampLimit(limit, 50));
  }

  searchMemory(projectPath: string, query: string, limit: number = 10): MemorySearchResult[] {
    const resolvedProjectPath = resolve(projectPath);
    const terms = tokenizeSearch(query);
    if (terms.length === 0) {
      return [];
    }

    const ledger = this.getRelevantLedger(resolvedProjectPath, query, limit).map((entry) => ({
      source: "ledger" as const,
      category: entry.category,
      title: entry.key,
      summary: entry.value,
      createdAt: entry.updatedAt
    }));
    const archives = this.getRecentArchives(resolvedProjectPath, 50)
      .map((entry) => ({
        entry,
        score: scoreText(`${entry.milestone} ${entry.summary} ${entry.unresolvedBlockers.join(" ")}`, terms)
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.entry.completedAt - left.entry.completedAt)
      .map(({ entry }) => ({
        source: "archive" as const,
        category: "milestone",
        title: entry.milestone,
        summary: entry.summary,
        createdAt: entry.completedAt
      }));
    return [...ledger, ...archives]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, clampLimit(limit, 50));
  }

  supersedeLedgerEntry(projectPath: string, key: string, value: string, category: MemoryLedgerCategory = "rule"): MemoryLedgerEntry {
    const resolvedProjectPath = resolve(projectPath);
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const entry = this.upsertLedgerEntry(
        resolvedProjectPath,
        null,
        { category, key: key.trim(), value: value.trim(), confidence: 1 },
        now
      );
      this.db.exec("COMMIT;");
      return entry;
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  getResumeContext(projectPath: string = process.cwd(), limit: number = DEFAULT_MEMORY_LIMIT): ProjectResumeContext {
    const resolvedProjectPath = resolve(projectPath);
    const activeSession = this.getActiveSession(resolvedProjectPath);
    return {
      projectPath: resolvedProjectPath,
      state: this.getProjectState(resolvedProjectPath),
      activeSession,
      activeScratchpad: activeSession ? this.getScratchpadEvents(activeSession.id, Math.min(limit, 5)) : [],
      recentArchives: this.getRecentArchives(resolvedProjectPath, 3),
      semanticLedger: this.getRelevantLedger(
        resolvedProjectPath,
        activeSession?.task ?? this.getProjectState(resolvedProjectPath).currentTask ?? "",
        5
      ),
      recentEvents: this.getRecentEvents(resolvedProjectPath, limit)
    };
  }

  setActiveProjectPath(projectPath: string, updatedAt: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO active_project (id, project_path, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET project_path = excluded.project_path, updated_at = excluded.updated_at`
      )
      .run(resolve(projectPath), updatedAt);
  }

  getActiveProjectPath(): string | null {
    const row = this.db.prepare("SELECT project_path FROM active_project WHERE id = 1").get() as ActiveProjectRow | undefined;
    return readString(row?.project_path);
  }

  getWatchedProjectCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT project_path) AS count
         FROM (
           SELECT project_path FROM project_changes
           UNION SELECT project_path FROM project_state
           UNION SELECT project_path FROM context_snapshots
           UNION SELECT project_path FROM project_overviews
           UNION SELECT project_path FROM active_project
           UNION SELECT project_path FROM memory_sessions
         )`
      )
      .get() as SqliteRow | undefined;
    return readNumber(row, "count");
  }

  getKnownProjectPaths(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT project_path FROM (
           SELECT project_path FROM project_changes
           UNION SELECT project_path FROM project_state
           UNION SELECT project_path FROM context_snapshots
           UNION SELECT project_path FROM project_overviews
           UNION SELECT project_path FROM active_project
           UNION SELECT project_path FROM memory_sessions
         ) WHERE project_path IS NOT NULL ORDER BY project_path`
      )
      .all() as Array<{ project_path?: unknown }>;
    return rows.map((row) => readString(row.project_path)).filter((value): value is string => value !== null);
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  saveContextSnapshot(input: ProjectContextSnapshotRecord): void {
    const projectPath = resolve(input.projectPath);
    this.db
      .prepare(
        `INSERT INTO context_snapshots
          (project_path, file_path, snapshot_json, snapshot_format, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_path) DO UPDATE SET
          file_path = excluded.file_path, snapshot_json = excluded.snapshot_json,
          snapshot_format = excluded.snapshot_format, updated_at = excluded.updated_at`
      )
      .run(projectPath, input.filePath, input.snapshotText, input.format, input.updatedAt);
    this.db
      .prepare(
        `INSERT INTO context_snapshot_history
          (project_path, file_path, snapshot_json, snapshot_format, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(projectPath, input.filePath, input.snapshotText, input.format, input.updatedAt);
    this.pruneContextSnapshotHistory(projectPath);
    if (input.activateProject ?? true) {
      this.setActiveProjectPath(projectPath, input.updatedAt);
    }
  }

  getLatestContextSnapshot(projectPath: string = process.cwd()): ProjectContextSnapshotRecord | null {
    const row = this.db
      .prepare(
        `SELECT project_path, file_path, snapshot_json, snapshot_format, updated_at
         FROM context_snapshots WHERE project_path = ?`
      )
      .get(resolve(projectPath)) as SqliteRow | undefined;
    const snapshotText = readString(row?.snapshot_json);
    const filePath = readString(row?.file_path);
    if (!snapshotText || !filePath) return null;
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
        `INSERT INTO project_overviews (project_id, project_path, overview_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
          project_path = excluded.project_path, overview_json = excluded.overview_json,
          updated_at = excluded.updated_at`
      )
      .run(input.projectId, resolve(input.projectPath), input.overviewJson, input.updatedAt);
  }

  getProjectOverview(projectPath: string): ProjectOverviewRecord | null {
    const row = this.db
      .prepare(
        `SELECT project_id, project_path, overview_json, updated_at
         FROM project_overviews WHERE project_path = ?`
      )
      .get(resolve(projectPath)) as SqliteRow | undefined;
    const projectId = readString(row?.project_id);
    const storedPath = readString(row?.project_path);
    const overviewJson = readString(row?.overview_json);
    const updatedAt = readNullableNumber(row, "updated_at");
    return projectId && storedPath && overviewJson && updatedAt !== null
      ? { projectId, projectPath: storedPath, overviewJson, updatedAt }
      : null;
  }

  close(): void {
    this.db.close();
  }

  private getOrStartSession(projectPath: string, task: string | null, startedAt: number): MemorySession {
    return this.getActiveSession(projectPath) ?? this.startSession(projectPath, task, startedAt);
  }

  private getArchiveBySession(sessionId: string): MemoryArchiveEntry | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, project_path, milestone, summary, files_json, blockers_json, completed_at
         FROM memory_archive WHERE session_id = ?`
      )
      .get(sessionId) as SqliteRow | undefined;
    return row ? readArchiveRow(row) : null;
  }

  private upsertLedgerEntry(
    projectPath: string,
    sourceSessionId: string | null,
    memory: DurableMemory,
    now: number
  ): MemoryLedgerEntry {
    const key = memory.key.trim();
    const value = memory.value.trim();
    if (!key || !value) {
      throw new Error("Ledger memory key and value are required");
    }
    const existingRow = this.db
      .prepare(
        `SELECT id, project_path, category, memory_key, value, status, source_session_id,
                confidence, created_at, updated_at, superseded_by
         FROM memory_ledger
         WHERE project_path = ? AND category = ? AND memory_key = ? AND status = 'active'
         ORDER BY id DESC LIMIT 1`
      )
      .get(projectPath, memory.category, key) as SqliteRow | undefined;
    const existing = existingRow ? readLedgerRow(existingRow) : null;
    if (existing?.value === value) {
      this.db
        .prepare(
          `UPDATE memory_ledger SET source_session_id = ?, confidence = ?, updated_at = ? WHERE id = ?`
        )
        .run(sourceSessionId, clampConfidence(memory.confidence), now, existing.id);
      return { ...existing, sourceSessionId, confidence: clampConfidence(memory.confidence), updatedAt: now };
    }

    const result = this.db
      .prepare(
        `INSERT INTO memory_ledger
          (project_path, category, memory_key, value, status, source_session_id,
           confidence, created_at, updated_at, superseded_by)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL)`
      )
      .run(projectPath, memory.category, key, value, sourceSessionId, clampConfidence(memory.confidence), now, now);
    const id = Number(result.lastInsertRowid);
    if (existing) {
      this.db
        .prepare("UPDATE memory_ledger SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?")
        .run(id, now, existing.id);
    }
    return {
      id,
      projectPath,
      category: memory.category,
      key,
      value,
      status: "active",
      sourceSessionId,
      confidence: clampConfidence(memory.confidence),
      createdAt: now,
      updatedAt: now,
      supersededBy: null
    };
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_changes (
        project_path TEXT NOT NULL, event_type TEXT, summary TEXT, details TEXT, created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS project_state (
        project_path TEXT PRIMARY KEY, current_task TEXT, last_plan_path TEXT,
        last_note TEXT, active_session_id TEXT, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS context_snapshots (
        project_path TEXT PRIMARY KEY, file_path TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        snapshot_format TEXT NOT NULL DEFAULT 'json', updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_snapshot_history (
        project_path TEXT NOT NULL, file_path TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        snapshot_format TEXT NOT NULL DEFAULT 'json', updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_project (
        id INTEGER PRIMARY KEY CHECK (id = 1), project_path TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_overviews (
        project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE,
        overview_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_sessions (
        id TEXT PRIMARY KEY, project_path TEXT NOT NULL, task TEXT,
        status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'abandoned')),
        started_at INTEGER NOT NULL, completed_at INTEGER, compacted_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS memory_scratchpad (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        project_path TEXT NOT NULL, event_type TEXT NOT NULL, summary TEXT NOT NULL,
        details TEXT, created_at INTEGER NOT NULL, compacted_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES memory_sessions(id)
      );
      CREATE TABLE IF NOT EXISTS memory_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL UNIQUE,
        project_path TEXT NOT NULL, milestone TEXT NOT NULL, summary TEXT NOT NULL,
        files_json TEXT, blockers_json TEXT, completed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_path TEXT NOT NULL,
        category TEXT NOT NULL, memory_key TEXT NOT NULL, value TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', source_session_id TEXT,
        confidence REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        superseded_by INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_project_changes_project_time
        ON project_changes(project_path, created_at);
      CREATE INDEX IF NOT EXISTS idx_context_snapshot_history_project_time
        ON context_snapshot_history(project_path, updated_at);
      CREATE INDEX IF NOT EXISTS idx_memory_sessions_project_status
        ON memory_sessions(project_path, status, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_scratchpad_session_time
        ON memory_scratchpad(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_archive_project_time
        ON memory_archive(project_path, completed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_ledger_project_status
        ON memory_ledger(project_path, status, updated_at DESC);
    `);
    this.ensureColumn("project_changes", "event_type", "TEXT");
    this.ensureColumn("project_changes", "summary", "TEXT");
    this.ensureColumn("project_changes", "details", "TEXT");
    this.ensureColumn("project_changes", "created_at", "INTEGER");
    this.ensureColumn("project_state", "active_session_id", "TEXT");
    this.ensureColumn("context_snapshots", "snapshot_format", "TEXT NOT NULL DEFAULT 'json'");
    this.ensureColumn("context_snapshot_history", "snapshot_format", "TEXT NOT NULL DEFAULT 'json'");
    this.normalizeDuplicateActiveSessions();
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_sessions_one_active
       ON memory_sessions(project_path) WHERE status = 'active';`
    );
    this.migrateLegacyProjectChanges();
    this.db
      .prepare(
        `INSERT INTO schema_migrations (name, version, applied_at)
         VALUES ('project_memory', ?, ?)
         ON CONFLICT(name) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`
      )
      .run(CURRENT_MEMORY_SCHEMA_VERSION, Date.now());
  }

  private migrateLegacyProjectChanges(): void {
    const migrated = this.db
      .prepare("SELECT version FROM schema_migrations WHERE name = 'legacy_project_changes'")
      .get() as SqliteRow | undefined;
    if (readNullableNumber(migrated, "version") !== null) return;

    const projectRows = this.db
      .prepare(
        `SELECT DISTINCT project_path FROM project_changes
         WHERE project_path IS NOT NULL AND COALESCE(event_type, 'note') != 'index'`
      )
      .all() as SqliteRow[];
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      for (const projectRow of projectRows) {
        const projectPath = readString(projectRow.project_path);
        if (!projectPath || this.getActiveSession(projectPath)) continue;
        const events = this.db
          .prepare(
            `SELECT project_path, event_type, summary, details, created_at
             FROM project_changes
             WHERE project_path = ? AND COALESCE(event_type, 'note') != 'index'
             ORDER BY COALESCE(created_at, 0) DESC, rowid DESC
             LIMIT 50`
          )
          .all(projectPath) as EventRow[];
        if (events.length === 0) continue;
        events.reverse();
        const state = this.getProjectState(projectPath);
        const sessionId = randomUUID();
        const startedAt = readNullableNumber(events[0] as SqliteRow, "created_at") ?? Date.now();
        this.db
          .prepare(
            `INSERT INTO memory_sessions
              (id, project_path, task, status, started_at, completed_at, compacted_at)
             VALUES (?, ?, ?, 'active', ?, NULL, NULL)`
          )
          .run(sessionId, projectPath, state.currentTask ?? state.lastNote, startedAt);
        const insert = this.db.prepare(
          `INSERT INTO memory_scratchpad
            (session_id, project_path, event_type, summary, details, created_at, compacted_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`
        );
        for (const eventRow of events) {
          const event = readEventRow(eventRow);
          insert.run(
            sessionId,
            projectPath,
            event.eventType,
            event.summary,
            event.details,
            event.createdAt
          );
        }
        this.db
          .prepare("UPDATE project_state SET active_session_id = ? WHERE project_path = ?")
          .run(sessionId, projectPath);
      }
      this.db
        .prepare(
          `INSERT INTO schema_migrations (name, version, applied_at)
           VALUES ('legacy_project_changes', 1, ?)`
        )
        .run(Date.now());
      this.db.exec("COMMIT;");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private ensureColumn(tableName: string, columnName: string, columnType: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
    if (!rows.some((row) => row.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
    }
  }

  private normalizeDuplicateActiveSessions(): void {
    const duplicateProjects = this.db
      .prepare(
        `SELECT project_path
         FROM memory_sessions
         WHERE status = 'active'
         GROUP BY project_path
         HAVING COUNT(*) > 1`
      )
      .all() as Array<{ project_path?: unknown }>;

    const abandon = this.db.prepare(
      `UPDATE memory_sessions
       SET status = 'abandoned', completed_at = COALESCE(completed_at, ?)
       WHERE project_path = ? AND status = 'active' AND id != ?`
    );
    for (const row of duplicateProjects) {
      const projectPath = readString(row.project_path);
      if (!projectPath) continue;
      const newest = this.db
        .prepare(
          `SELECT id FROM memory_sessions
           WHERE project_path = ? AND status = 'active'
           ORDER BY started_at DESC, rowid DESC LIMIT 1`
        )
        .get(projectPath) as SqliteRow | undefined;
      const newestId = readString(newest?.id);
      if (newestId) abandon.run(Date.now(), projectPath, newestId);
    }
  }

  private pruneLegacyEvents(projectPath: string, maximumRows: number = 500): void {
    this.db
      .prepare(
        `DELETE FROM project_changes
         WHERE project_path = ? AND rowid NOT IN (
           SELECT rowid FROM project_changes
           WHERE project_path = ?
           ORDER BY COALESCE(created_at, 0) DESC, rowid DESC
           LIMIT ?
         )`
      )
      .run(projectPath, projectPath, maximumRows);
  }

  private pruneContextSnapshotHistory(projectPath: string, maximumRows: number = 100): void {
    this.db
      .prepare(
        `DELETE FROM context_snapshot_history
         WHERE project_path = ? AND rowid NOT IN (
           SELECT rowid FROM context_snapshot_history
           WHERE project_path = ?
           ORDER BY updated_at DESC, rowid DESC
           LIMIT ?
         )`
      )
      .run(projectPath, projectPath, maximumRows);
  }

  private upsertState(input: {
    projectPath: string;
    currentTask: string | null;
    inferCurrentTask: boolean;
    lastPlanPath: string | null;
    lastNote: string;
    activeSessionId: string | null;
    updatedAt: number;
  }): void {
    const existing = this.getProjectState(input.projectPath);
    const currentTask = input.currentTask ?? existing.currentTask ?? (input.inferCurrentTask ? input.lastNote : null);
    this.db
      .prepare(
        `INSERT INTO project_state
          (project_path, current_task, last_plan_path, last_note, active_session_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_path) DO UPDATE SET
          current_task = excluded.current_task, last_plan_path = excluded.last_plan_path,
          last_note = excluded.last_note, active_session_id = excluded.active_session_id,
          updated_at = excluded.updated_at`
      )
      .run(
        input.projectPath,
        currentTask,
        input.lastPlanPath ?? existing.lastPlanPath,
        input.lastNote,
        input.activeSessionId ?? existing.activeSessionId,
        input.updatedAt
      );
  }

  private setStateActiveSession(projectPath: string, sessionId: string, task: string | null, updatedAt: number): void {
    const existing = this.getProjectState(projectPath);
    this.db
      .prepare(
        `INSERT INTO project_state
          (project_path, current_task, last_plan_path, last_note, active_session_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_path) DO UPDATE SET
          current_task = excluded.current_task, active_session_id = excluded.active_session_id,
          updated_at = excluded.updated_at`
      )
      .run(projectPath, task ?? existing.currentTask, existing.lastPlanPath, existing.lastNote, sessionId, updatedAt);
  }

  private getProjectState(projectPath: string): ProjectState {
    const row = this.db
      .prepare(
        `SELECT project_path, current_task, last_plan_path, last_note, active_session_id, updated_at
         FROM project_state WHERE project_path = ?`
      )
      .get(projectPath) as StateRow | undefined;
    return {
      projectPath,
      currentTask: readString(row?.current_task),
      lastPlanPath: readString(row?.last_plan_path),
      lastNote: readString(row?.last_note),
      activeSessionId: readString(row?.active_session_id),
      updatedAt: readNullableNumber(row, "updated_at")
    };
  }

  private getRecentEvents(projectPath: string, limit: number): ProjectMemoryEvent[] {
    const rows = (this.db.prepare(
      `SELECT project_path, event_type, summary, details, created_at
       FROM project_changes WHERE project_path = ?
       ORDER BY COALESCE(created_at, 0) DESC, rowid DESC LIMIT ?`
    ) as StatementSync).all(projectPath, clampLimit(limit, 50)) as EventRow[];
    return rows.map(readEventRow);
  }
}

export function formatResumeContext(context: ProjectResumeContext, nowMs: number = Date.now()): string {
  const scratchpad = context.activeScratchpad.map(
    (event) => `- ${event.eventType}: ${event.summary} (${formatRelativeTime(event.createdAt, nowMs)})`
  );
  const archives = context.recentArchives.map(
    (entry) => `- ${entry.milestone}: ${entry.summary} (${formatRelativeTime(entry.completedAt, nowMs)})`
  );
  const ledger = context.semanticLedger.map(
    (entry) => `- ${entry.category}/${entry.key}: ${entry.value}`
  );
  return [
    "Infimium project memory",
    `Project: ${context.projectPath}`,
    `Current task: ${context.state.currentTask ?? "Not set"}`,
    `Active session: ${context.activeSession?.id ?? "None"}`,
    `Last note: ${context.state.lastNote ?? "None"}`,
    `Last plan: ${context.state.lastPlanPath ?? "None"}`,
    `Last updated: ${context.state.updatedAt ? formatRelativeTime(context.state.updatedAt, nowMs) : "never"}`,
    "",
    "Semantic ledger:",
    ledger.length > 0 ? ledger.join("\n") : "No durable project rules recorded.",
    "",
    "Recent milestones:",
    archives.length > 0 ? archives.join("\n") : "No completed sessions archived.",
    "",
    "Active scratchpad:",
    scratchpad.length > 0 ? scratchpad.join("\n") : "No active session events.",
    "",
    "Use get_context for the complete live repository snapshot."
  ].join("\n");
}

function readEventRow(row: EventRow): ProjectMemoryEvent {
  return {
    projectPath: readString(row.project_path) ?? "",
    eventType: readEventType(row.event_type),
    summary: readString(row.summary) ?? "(no summary)",
    details: readString(row.details),
    createdAt: readNullableNumber(row, "created_at") ?? 0
  };
}

function readSessionRow(row: SqliteRow): MemorySession {
  const status = row.status === "completed" || row.status === "abandoned" ? row.status : "active";
  return {
    id: readString(row.id) ?? "",
    projectPath: readString(row.project_path) ?? "",
    task: readString(row.task),
    status,
    startedAt: readNullableNumber(row, "started_at") ?? 0,
    completedAt: readNullableNumber(row, "completed_at"),
    compactedAt: readNullableNumber(row, "compacted_at")
  };
}

function readScratchpadRow(row: SqliteRow): MemoryScratchpadEvent {
  return {
    id: readNullableNumber(row, "id") ?? 0,
    sessionId: readString(row.session_id) ?? "",
    projectPath: readString(row.project_path) ?? "",
    eventType: readEventType(row.event_type),
    summary: readString(row.summary) ?? "(no summary)",
    details: readString(row.details),
    createdAt: readNullableNumber(row, "created_at") ?? 0,
    compactedAt: readNullableNumber(row, "compacted_at")
  };
}

function readArchiveRow(row: SqliteRow): MemoryArchiveEntry {
  return {
    id: readNullableNumber(row, "id") ?? 0,
    sessionId: readString(row.session_id) ?? "",
    projectPath: readString(row.project_path) ?? "",
    milestone: readString(row.milestone) ?? "Completed task",
    summary: readString(row.summary) ?? "",
    relevantFiles: parseStringArray(row.files_json),
    unresolvedBlockers: parseStringArray(row.blockers_json),
    completedAt: readNullableNumber(row, "completed_at") ?? 0
  };
}

function readLedgerRow(row: SqliteRow): MemoryLedgerEntry {
  return {
    id: readNullableNumber(row, "id") ?? 0,
    projectPath: readString(row.project_path) ?? "",
    category: readLedgerCategory(row.category),
    key: readString(row.memory_key) ?? "memory",
    value: readString(row.value) ?? "",
    status: row.status === "superseded" ? "superseded" : "active",
    sourceSessionId: readString(row.source_session_id),
    confidence: readNullableNumber(row, "confidence"),
    createdAt: readNullableNumber(row, "created_at") ?? 0,
    updatedAt: readNullableNumber(row, "updated_at") ?? 0,
    supersededBy: readNullableNumber(row, "superseded_by")
  };
}

function readEventType(value: unknown): ProjectMemoryEventType {
  return value === "progress" || value === "decision" || value === "blocker" ||
    value === "index" || value === "plan" ? value : "note";
}

function readLedgerCategory(value: unknown): MemoryLedgerCategory {
  return value === "decision" || value === "quirk" || value === "blocker" ? value : "rule";
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function tokenizeSearch(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [])].slice(0, 20);
}

function scoreLedgerEntry(entry: MemoryLedgerEntry, terms: string[]): number {
  return scoreText(`${entry.category} ${entry.key} ${entry.value}`, terms);
}

function scoreText(value: string, terms: string[]): number {
  const normalized = value.toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}

function clampLimit(value: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
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
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function formatRelativeTime(timestampMs: number, nowMs: number): string {
  if (!timestampMs) return "unknown time";
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (elapsedSeconds < 60) return elapsedSeconds === 1 ? "1 second ago" : `${elapsedSeconds} seconds ago`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return elapsedMinutes === 1 ? "1 minute ago" : `${elapsedMinutes} minutes ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return elapsedHours === 1 ? "1 hour ago" : `${elapsedHours} hours ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return elapsedDays === 1 ? "1 day ago" : `${elapsedDays} days ago`;
}
