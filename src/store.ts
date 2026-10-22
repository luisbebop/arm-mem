import { randomUUID } from "node:crypto";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";

export const MEMORY_KINDS = [
  "semantic", "episodic", "procedural", "preference", "decision", "observation", "consolidated",
] as const;
export const MEMORY_STATUSES = ["proposed", "accepted", "retired", "rejected", "expired"] as const;
export const RETENTION_POLICIES = ["permanent", "stable", "temporary", "session"] as const;

export type MemoryKind = typeof MEMORY_KINDS[number];
export type MemoryStatus = typeof MEMORY_STATUSES[number];
export type RetentionPolicy = typeof RETENTION_POLICIES[number];

export interface MemoryDraft {
  content: string;
  evidence: string;
  kind?: MemoryKind;
  importance?: number;
  confidence?: number;
  retention?: RetentionPolicy;
  expires_at?: number | null;
  expiresAt?: number | null;
}
export interface MemoryOptions {
  author?: string;
  kind?: MemoryKind;
  importance?: number;
  confidence?: number;
  retention?: RetentionPolicy;
  expires_at?: number | null;
  expiresAt?: number | null;
}
export interface Memory {
  id: number;
  content: string;
  evidence: string;
  source_task: number | null;
  author: string;
  status: MemoryStatus;
  kind: MemoryKind;
  importance: number;
  confidence: number;
  retention: RetentionPolicy;
  expires_at: number | null;
  created_at: number;
}
export interface Answer {
  answer: string;
  memories?: MemoryDraft[];
  usage?: Record<string, unknown>;
}
export interface Task {
  id: number;
  prompt: string;
  priority: number;
  state: "queued" | "running" | "done" | "failed";
  attempts: number;
  worker: string | null;
  claim: string | null;
  lease_until: number | null;
  result: string | null;
  error: string | null;
  created_at: number;
}
export interface ClaimedTask extends Task {
  state: "running";
  worker: string;
  claim: string;
  lease_until: number;
}
export class LostClaim extends Error {}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T[number];
  throw new Error(`Invalid ${label}. Expected one of: ${allowed.join(", ")}.`);
}

function unitInterval(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) return value;
  throw new Error(`${label} must be a number between 0 and 1.`);
}

function normalizeMemoryMetadata(options: Partial<MemoryDraft | MemoryOptions> = {}) {
  const expiresAt = options.expires_at ?? options.expiresAt ?? null;
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt < 0)) {
    throw new Error("expires_at must be a non-negative Unix timestamp or null.");
  }
  return {
    kind: oneOf(options.kind ?? "semantic", MEMORY_KINDS, "memory kind"),
    importance: unitInterval(options.importance ?? 0.5, "importance"),
    confidence: unitInterval(options.confidence ?? 1.0, "confidence"),
    retention: oneOf(options.retention ?? "stable", RETENTION_POLICIES, "retention policy"),
    expires_at: expiresAt,
  };
}

function splitMemoryOptions(authorOrOptions: string | MemoryOptions = "user") {
  if (typeof authorOrOptions === "string") {
    return { author: authorOrOptions, metadata: normalizeMemoryMetadata() };
  }
  return {
    author: authorOrOptions.author ?? "user",
    metadata: normalizeMemoryMetadata(authorOrOptions),
  };
}

/** One local database shared by replaceable worker processes. */
export class Store {
  readonly identity: string;
  private db: DatabaseSync;
  private now: () => number;

  constructor(path = "arm-mem.db", now = () => Date.now() / 1000) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout=15000;
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, prompt TEXT NOT NULL, priority INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
        worker TEXT, claim TEXT, lease_until REAL, result TEXT, error TEXT,
        created_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY, content TEXT NOT NULL UNIQUE, evidence TEXT NOT NULL,
        source_task INTEGER REFERENCES tasks(id), author TEXT NOT NULL,
        status TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'semantic',
        importance REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 1.0,
        retention TEXT NOT NULL DEFAULT 'stable', expires_at REAL,
        created_at REAL NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(content);
      CREATE INDEX IF NOT EXISTS task_queue ON tasks(state, priority DESC, id);
    `);
    this.migrateMemorySchema();
    this.db.prepare("INSERT INTO identity SELECT ? WHERE NOT EXISTS (SELECT 1 FROM identity)")
      .run(randomUUID());
    this.identity = this.db.prepare("SELECT id FROM identity").get()!.id as string;
  }

  close(): void { this.db.close(); }

  private migrateMemorySchema(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(memories)").all() as { name: string }[])
      .map(column => column.name));
    for (const definition of [
      "kind TEXT NOT NULL DEFAULT 'semantic'",
      "importance REAL NOT NULL DEFAULT 0.5",
      "confidence REAL NOT NULL DEFAULT 1.0",
      "retention TEXT NOT NULL DEFAULT 'stable'",
      "expires_at REAL",
    ]) {
      const name = definition.split(" ")[0]!;
      if (!columns.has(name)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${definition}`);
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertMemory(content: string, evidence: string, author: string,
    status: MemoryStatus, task: number | null = null,
    options: Partial<MemoryDraft | MemoryOptions> = {}): number {
    content = content.trim();
    evidence = evidence.trim();
    const metadata = normalizeMemoryMetadata(options);
    if (!content || [...content].length > 2000 || !evidence) {
      throw new Error("Memory needs 1–2000 characters and source evidence.");
    }
    oneOf(status, MEMORY_STATUSES, "memory status");
    const row = this.db.prepare(`
      INSERT INTO memories(content, evidence, author, status, source_task, created_at,
        kind, importance, confidence, retention, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(content) DO NOTHING RETURNING id
    `).get(content, evidence, author, status, task, this.now(), metadata.kind,
      metadata.importance, metadata.confidence, metadata.retention, metadata.expires_at);
    if (row) {
      this.db.prepare("INSERT INTO memory_search(rowid, content) VALUES (?, ?)").run(row.id!, content);
      return row.id as number;
    }
    return this.db.prepare("SELECT id FROM memories WHERE content=?").get(content)!.id as number;
  }

  /** Explicitly supplied facts are accepted. Exact duplicates retain their original status and metadata. */
  remember(content: string, evidence: string, authorOrOptions: string | MemoryOptions = "user"): number {
    const { author, metadata } = splitMemoryOptions(authorOrOptions);
    return this.transaction(() => this.insertMemory(content, evidence, author, "accepted", null, metadata));
  }

  /** Store long source text verbatim in overlapping 1,800-character chunks. */
  ingest(text: string, evidence: string, authorOrOptions: string | MemoryOptions = "user"): number[] {
    if (!text.trim()) throw new Error("Source text must not be blank.");
    const chars = [...text];
    const { author, metadata } = splitMemoryOptions(authorOrOptions);
    return this.transaction(() => {
      const ids: number[] = [];
      for (let start = 0; start < chars.length; start += 1600) {
        const part = chars.slice(start, start + 1800).join("");
        if (part.trim()) ids.push(this.insertMemory(part, evidence, author, "accepted", null, metadata));
        if (start + 1800 >= chars.length) break;
      }
      return ids;
    });
  }

  /** Rank up to 32 quoted OR terms by BM25, then newest ID. */
  recall(query: string, limit = 100): Memory[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Limit must be 1–100.");
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 32);
    if (!words.length) return [];
    const match = words.map(word => `"${word}"`).join(" OR ");
    return this.db.prepare(`
      SELECT m.* FROM memory_search JOIN memories m ON m.id=memory_search.rowid
      WHERE memory_search MATCH ? AND m.status='accepted'
      ORDER BY bm25(memory_search), m.id DESC LIMIT ?
    `).all(match, limit) as unknown as Memory[];
  }

  review(id: number, status: Exclude<MemoryStatus, "proposed">): void {
    oneOf(status, MEMORY_STATUSES.filter(value => value !== "proposed"), "review status");
    if (!this.db.prepare("UPDATE memories SET status=? WHERE id=?").run(status, id).changes) {
      throw new Error("Memory not found.");
    }
  }

  enqueue(prompt: string, priority = 0): number {
    if (!prompt.trim()) throw new Error("Task must not be blank.");
    if (!Number.isSafeInteger(priority)) throw new Error("Priority must be an integer.");
    return Number(this.db.prepare("INSERT INTO tasks(prompt, priority, created_at) VALUES (?, ?, ?)")
      .run(prompt, priority, this.now()).lastInsertRowid);
  }

  claim(worker: string, leaseSeconds = 360): ClaimedTask | undefined {
    if (!worker.trim() || !Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
      throw new Error("A worker name and positive lease are required.");
    }
    return this.transaction(() => {
      const now = this.now();
      this.db.prepare(`UPDATE tasks SET state='failed', error='Worker lease expired three times'
        WHERE state='running' AND lease_until<=? AND attempts>=3`).run(now);
      return this.db.prepare(`
        UPDATE tasks SET state='running', worker=?, claim=?, lease_until=?,
          attempts=attempts+1, error=NULL
        WHERE id=(SELECT id FROM tasks WHERE state='queued'
          OR (state='running' AND lease_until<=? AND attempts<3)
          ORDER BY priority DESC, id LIMIT 1) RETURNING *
      `).get(worker, randomUUID(), now + leaseSeconds, now) as unknown as ClaimedTask | undefined;
    });
  }

  finish(task: ClaimedTask, result: Answer, usedMemoryIds: number[]): void {
    if (typeof result?.answer !== "string" || !result.answer.trim()) throw new Error("Empty agent answer.");
    const memories = result.memories ?? [];
    if (!Array.isArray(memories) || memories.length > 3) throw new Error("At most three memory proposals.");
    this.transaction(() => {
      const changed = this.db.prepare(`UPDATE tasks SET state='done', result=?, lease_until=NULL
        WHERE id=? AND state='running' AND claim=? AND lease_until>?`)
        .run(JSON.stringify({ ...result, used_memory_ids: usedMemoryIds }), task.id, task.claim, this.now());
      if (!changed.changes) throw new LostClaim("Task lease expired or another worker reclaimed it.");
      for (const memory of memories) {
        if (typeof memory?.content !== "string" || typeof memory?.evidence !== "string") {
          throw new Error("A memory proposal needs content and evidence strings.");
        }
        this.insertMemory(memory.content, memory.evidence, task.worker, "proposed", task.id, memory);
      }
    });
  }

  fail(task: ClaimedTask, error: unknown): void {
    this.db.prepare(`UPDATE tasks SET state='failed', error=?, lease_until=NULL
      WHERE id=? AND state='running' AND claim=? AND lease_until>?`)
      .run(error instanceof Error ? error.message : String(error), task.id, task.claim, this.now());
  }

  retry(id: number): void {
    const changed = this.db.prepare(`UPDATE tasks SET state='queued', attempts=0, error=NULL,
      claim=NULL, lease_until=NULL WHERE id=? AND state='failed'`).run(id);
    if (!changed.changes) throw new Error("Only a failed task can be retried.");
  }

  tasks(): Task[] { return this.db.prepare("SELECT * FROM tasks ORDER BY id").all() as unknown as Task[]; }
  memories(): Memory[] { return this.db.prepare("SELECT * FROM memories ORDER BY id").all() as unknown as Memory[]; }

  /** Includes committed WAL data. Refuses to overwrite an existing file. */
  async backup(path: string): Promise<void> {
    closeSync(openSync(path, "wx", 0o600));
    try { await backup(this.db, path); }
    catch (error) { unlinkSync(path); throw error; }
  }
}
