import {DatabaseSync} from 'node:sqlite';
import {chmodSync, lstatSync, mkdirSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import type {LearningAttempt, MemoryEntry} from './types.js';
import {fingerprint} from './safety.js';

export const LEARNING_DATABASE_FILE = 'learning.sqlite';
type DataRow = {data: string};
/** Only this database owns learning state; goal usage stays in the original SessionStore. */
export class LearningDatabase {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(stateDir: string) {
    mkdirSync(stateDir, {recursive: true, mode: 0o700});
    const path = join(realpathSync(stateDir), LEARNING_DATABASE_FILE);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const state = lstatSync(path+suffix,{throwIfNoEntry:false});
      if (state && (!state.isFile() || state.isSymbolicLink())) throw new Error('Learning database and journals must be regular files');
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      const version = (this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
      if (version > 1) throw new Error('Learning database version is newer than this service');
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS learning_entries(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, partition TEXT NOT NULL CHECK(partition IN ('development','production')), fingerprint TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project_id,partition,fingerprint));
        CREATE INDEX IF NOT EXISTS learning_project ON learning_entries(project_id,partition);
        CREATE TABLE IF NOT EXISTS learning_history(seq INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS learning_history_no_update BEFORE UPDATE ON learning_history BEGIN SELECT RAISE(ABORT,'Learning history is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS learning_history_no_delete BEFORE DELETE ON learning_history BEGIN SELECT RAISE(ABORT,'Learning history is append-only'); END;
        CREATE TABLE IF NOT EXISTS learning_attempts(id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(goal_id,revision));
        PRAGMA user_version=1; COMMIT;`);
      chmodSync(path, 0o600);
    } catch (error) {this.db.close(); throw error;}
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result = operation(); this.db.exec('COMMIT'); return result;} catch (error) {this.db.exec('ROLLBACK'); throw error;}
  }
  entries(projectId: string, partition?: string): MemoryEntry[] {
    const rows = partition === undefined ? this.db.prepare('SELECT data FROM learning_entries WHERE project_id=? ORDER BY id').all(projectId) : this.db.prepare('SELECT data FROM learning_entries WHERE project_id=? AND partition=? ORDER BY id').all(projectId, partition);
    return (rows as DataRow[]).map(row => JSON.parse(row.data) as MemoryEntry);
  }
  getEntry(id: string): MemoryEntry | undefined {const row = this.db.prepare('SELECT data FROM learning_entries WHERE id=?').get(id) as DataRow | undefined; return row ? JSON.parse(row.data) as MemoryEntry : undefined;}
  putEntry(entry: MemoryEntry, action: string): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO learning_entries VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,data=excluded.data').run(entry.id, entry.projectId, entry.partition, fingerprint(entry.text), JSON.stringify(entry));
      this.db.prepare('INSERT INTO learning_history(entry_id,action,data,created_at) VALUES(?,?,?,?)').run(entry.id, action, JSON.stringify(entry), entry.updatedAt);
    });
  }
  attempt(goalId: string, revision: number): LearningAttempt | undefined {const row = this.db.prepare('SELECT data FROM learning_attempts WHERE goal_id=? AND revision=?').get(goalId, revision) as DataRow | undefined; return row ? JSON.parse(row.data) as LearningAttempt : undefined;}
  putAttempt(attempt: LearningAttempt): void {this.db.prepare('INSERT INTO learning_attempts VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(attempt.id, attempt.goalId, attempt.revision, attempt.status, JSON.stringify(attempt));}
  /** Atomic claim across same-database service instances/processes. */
  claim(attempt: LearningAttempt): boolean {
    return this.transaction(() => {
      const prior = this.attempt(attempt.goalId, attempt.revision);
      if (prior && prior.status !== 'pending-budget') return false;
      this.putAttempt(attempt); return true;
    });
  }
  close(): void {if (!this.closed) {this.closed = true; this.db.close();}}
}
