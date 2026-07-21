import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { dataPath } from "./paths.js";

export type VectorMetadata = Record<string, string | number | boolean>;

type VectorFieldWhere = Record<
  string,
  string | number | boolean | { $eq: string | number | boolean }
>;
export type VectorWhere = VectorFieldWhere | { $and: VectorWhere[] };

export type VectorQueryResult = {
  ids: string[][];
  documents: Array<Array<string | null>>;
  metadatas: Array<Array<VectorMetadata | null>>;
  distances: Array<Array<number | null>>;
};

type StoredVectorRow = {
  id: string;
  document: string;
  metadata_json: string;
  embedding: Uint8Array;
  dimension: number;
};

const DEFAULT_VECTOR_DB_PATH = dataPath("vectors.db");
const require = createRequire(import.meta.url);
type Database = import("node:sqlite").DatabaseSync;

export class EmbeddedVectorClient {
  readonly dbPath: string;

  constructor(dbPath: string = DEFAULT_VECTOR_DB_PATH) {
    this.dbPath = resolve(dbPath);
  }

  async getOrCreateCollection(args: {
    name: string;
    embeddingFunction?: null;
  }): Promise<EmbeddedVectorCollection> {
    this.withDatabase((db) => {
      db.prepare("INSERT OR IGNORE INTO vector_collections (name) VALUES (?)").run(args.name);
    });
    return new EmbeddedVectorCollection(this.dbPath, args.name);
  }

  async getCollection(args: { name: string }): Promise<EmbeddedVectorCollection> {
    const exists = this.withDatabase((db) =>
      db.prepare("SELECT 1 FROM vector_collections WHERE name = ?").get(args.name)
    );
    if (!exists) {
      throw new Error(`Vector collection does not exist: ${args.name}`);
    }
    return new EmbeddedVectorCollection(this.dbPath, args.name);
  }

  private withDatabase<T>(callback: (db: Database) => T): T {
    const db = openDatabase(this.dbPath);
    try {
      return callback(db);
    } finally {
      db.close();
    }
  }
}

export class EmbeddedVectorCollection {
  constructor(
    private readonly dbPath: string,
    private readonly name: string
  ) {}

  async count(): Promise<number> {
    return this.withDatabase((db) => {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE collection = ?")
        .get(this.name) as { count?: number | bigint } | undefined;
      return Number(row?.count ?? 0);
    });
  }

  async upsert(args: {
    ids: string[];
    embeddings: number[][];
    documents: string[];
    metadatas: VectorMetadata[];
  }): Promise<void> {
    const length = args.ids.length;
    if (
      args.embeddings.length !== length ||
      args.documents.length !== length ||
      args.metadatas.length !== length
    ) {
      throw new Error("Vector upsert arrays must have the same length");
    }

    this.withDatabase((db) => {
      const statement = db.prepare(
        `INSERT OR REPLACE INTO vector_entries
          (collection, id, document, metadata_json, embedding, dimension, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let index = 0; index < length; index += 1) {
          const embedding = args.embeddings[index];
          validateEmbedding(embedding);
          statement.run(
            this.name,
            args.ids[index],
            args.documents[index],
            JSON.stringify(args.metadatas[index]),
            encodeEmbedding(embedding),
            embedding.length,
            Date.now()
          );
        }
        db.exec("COMMIT");
      } catch (error: unknown) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async delete(args: { where?: VectorWhere; ids?: string[] }): Promise<void> {
    this.withDatabase((db) => {
      const rows = readRows(db, this.name);
      const ids = new Set(args.ids ?? []);
      const deleteStatement = db.prepare(
        "DELETE FROM vector_entries WHERE collection = ? AND id = ?"
      );

      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          const metadata = parseMetadata(row.metadata_json);
          if ((ids.size === 0 || ids.has(row.id)) && matchesWhere(metadata, args.where)) {
            deleteStatement.run(this.name, row.id);
          }
        }
        db.exec("COMMIT");
      } catch (error: unknown) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async get(args: {
    include?: Array<"documents" | "metadatas" | "embeddings">;
    where?: VectorWhere;
    ids?: string[];
  } = {}): Promise<{
    ids: string[];
    documents: Array<string | null>;
    metadatas: Array<VectorMetadata | null>;
    embeddings: Array<number[] | null>;
  }> {
    return this.withDatabase((db) => {
      const idFilter = args.ids ? new Set(args.ids) : null;
      const rows = readRows(db, this.name).filter((row) => {
        const metadata = parseMetadata(row.metadata_json);
        return (!idFilter || idFilter.has(row.id)) && matchesWhere(metadata, args.where);
      });

      return {
        ids: rows.map((row) => row.id),
        documents: rows.map((row) => row.document),
        metadatas: rows.map((row) => parseMetadata(row.metadata_json)),
        embeddings: rows.map((row) => decodeEmbedding(row.embedding, row.dimension))
      };
    });
  }

  async query(args: {
    queryEmbeddings: number[][];
    nResults: number;
    include?: Array<"documents" | "metadatas" | "distances">;
    where?: VectorWhere;
  }): Promise<VectorQueryResult> {
    if (!Number.isInteger(args.nResults) || args.nResults < 1) {
      throw new Error("nResults must be a positive integer");
    }

    return this.withDatabase((db) => {
      const candidates = readRows(db, this.name)
        .map((row) => ({
          row,
          metadata: parseMetadata(row.metadata_json),
          vector: decodeEmbedding(row.embedding, row.dimension)
        }))
        .filter(({ metadata }) => matchesWhere(metadata, args.where));

      const ids: string[][] = [];
      const documents: Array<Array<string | null>> = [];
      const metadatas: Array<Array<VectorMetadata | null>> = [];
      const distances: Array<Array<number | null>> = [];

      for (const queryEmbedding of args.queryEmbeddings) {
        validateEmbedding(queryEmbedding);
        const ranked = candidates
          .filter(({ vector }) => vector.length === queryEmbedding.length)
          .map((candidate) => ({
            ...candidate,
            distance: cosineDistance(queryEmbedding, candidate.vector)
          }))
          .sort((left, right) => left.distance - right.distance)
          .slice(0, args.nResults);

        ids.push(ranked.map(({ row }) => row.id));
        documents.push(ranked.map(({ row }) => row.document));
        metadatas.push(ranked.map(({ metadata }) => metadata));
        distances.push(ranked.map(({ distance }) => distance));
      }

      return { ids, documents, metadatas, distances };
    });
  }

  private withDatabase<T>(callback: (db: Database) => T): T {
    const db = openDatabase(this.dbPath);
    try {
      return callback(db);
    } finally {
      db.close();
    }
  }
}

export function createVectorClient(dbPath?: string): EmbeddedVectorClient {
  return new EmbeddedVectorClient(dbPath);
}

function openDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS vector_collections (
      name TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE IF NOT EXISTS vector_entries (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      document TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      embedding BLOB NOT NULL,
      dimension INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (collection, id),
      FOREIGN KEY (collection) REFERENCES vector_collections(name) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS vector_entries_collection_idx
      ON vector_entries(collection);
  `);
  return db;
}

function readRows(db: Database, collection: string): StoredVectorRow[] {
  return db
    .prepare(
      `SELECT id, document, metadata_json, embedding, dimension
       FROM vector_entries WHERE collection = ?`
    )
    .all(collection) as StoredVectorRow[];
}

function encodeEmbedding(embedding: number[]): Uint8Array {
  const values = Float32Array.from(embedding);
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

function decodeEmbedding(value: Uint8Array, dimension: number): number[] {
  const bytes = Uint8Array.from(value);
  if (bytes.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error("Stored vector has an invalid dimension");
  }
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, dimension));
}

function validateEmbedding(embedding: number[]): void {
  if (embedding.length === 0 || !embedding.every(Number.isFinite)) {
    throw new Error("Embedding must contain finite numeric values");
  }
}

function parseMetadata(value: string): VectorMetadata {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored vector metadata is invalid");
  }
  return parsed as VectorMetadata;
}

function matchesWhere(metadata: VectorMetadata, where?: VectorWhere): boolean {
  if (!where) {
    return true;
  }
  const conjunction = (where as { $and?: unknown }).$and;
  if (Array.isArray(conjunction)) {
    return conjunction.every((entry) => matchesWhere(metadata, entry as VectorWhere));
  }

  return Object.entries(where).every(([key, expected]) => {
    const value = metadata[key];
    if (typeof expected === "object") {
      return value === expected.$eq;
    }
    return value === expected;
  });
}

function cosineDistance(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 1;
  }
  const similarity = dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
  return 1 - Math.max(-1, Math.min(1, similarity));
}
