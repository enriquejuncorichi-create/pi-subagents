import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { WorkerRoute } from "./managed-worker-runtime.js";
import type { ThinkingLevel } from "./types.js";

export interface WorkerOwner { id: string; parentFile: string; workspace: string }
export interface StoredWorker {
  version: 1;
  owner: WorkerOwner;
  handle: string;
  type: string;
  route: WorkerRoute;
  cwd: string;
  access: "read-only" | "write";
  thinking?: ThinkingLevel;
  maxTurns: number;
  state: "starting" | "running" | "completed" | "error" | "stopped";
  sessionFile?: string;
  sessionId?: string;
  systemHash?: string;
  updatedAt: number;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
export const workerHash = (text: string): string => createHash("sha256").update(text).digest("hex");
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

function plainFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Managed store requires a regular unlinked file");
}
function directory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || !samePath(realpathSync.native(path), resolve(path))) throw new Error("Managed store directory cannot traverse a link");
  return realpathSync.native(path);
}

/** Handles select files inside this private store, never arbitrary transcript paths.
 * Ownership requires the same persistent Pi session AND canonical workspace.
 * No PID-based stale-lock recovery: interrupted writers require explicit human
 * reconciliation before their lock is removed. Nothing is replayed on restart.
 */
export class ManagedWorkerStore {
  constructor(private readonly root: string) {}

  private ownerRoot(owner: WorkerOwner): string {
    plainFile(owner.parentFile);
    if (!samePath(realpathSync.native(owner.parentFile), owner.parentFile)
      || !samePath(realpathSync.native(owner.workspace), owner.workspace)) throw new Error("Worker owner path changed");
    const root = directory(resolve(this.root));
    return directory(join(root, workerHash(JSON.stringify(owner))));
  }

  sessionDirectory(owner: WorkerOwner, handle: string): string {
    if (!UUID.test(handle)) throw new Error("Invalid managed worker handle");
    return directory(join(this.ownerRoot(owner), handle));
  }

  save(record: StoredWorker): void {
    const folder = this.sessionDirectory(record.owner, record.handle);
    const file = join(folder, "manifest.json");
    if (existsSync(file)) plainFile(file);
    const temporary = join(folder, `manifest-${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    // Same-directory rename is atomic on supported local Windows/Linux filesystems.
    renameSync(temporary, file);
  }

  load(owner: WorkerOwner, handle: string): StoredWorker {
    if (!UUID.test(handle)) throw new Error("Unknown or stale worker handle");
    const file = join(this.ownerRoot(owner), handle, "manifest.json");
    if (!existsSync(file)) throw new Error("Unknown or foreign worker handle");
    const folder = this.sessionDirectory(owner, handle);
    plainFile(file);
    if (statSync(file).size > 16_384) throw new Error("Oversized worker manifest");
    let value: unknown;
    try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("Corrupt worker manifest; no recovery or replay attempted"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid worker manifest");
    const record = value as StoredWorker;
    if (record.version !== 1 || record.handle !== handle || JSON.stringify(record.owner) !== JSON.stringify(owner)
      || typeof record.type !== "string" || !record.type || record.type.length > 128
      || !record.route || typeof record.route.provider !== "string" || typeof record.route.model !== "string"
      || !record.route.model || record.route.model.length > 240
      || !["openai-codex", "xai"].includes(record.route.provider)
      || !["read-only", "write"].includes(record.access)
      || (record.thinking !== undefined && !["minimal", "low", "medium", "high", "xhigh", "max"].includes(record.thinking))
      || !Number.isInteger(record.maxTurns) || record.maxTurns < 1 || record.maxTurns > 128
      || !["starting", "running", "completed", "error", "stopped"].includes(record.state)
      || typeof record.cwd !== "string" || !samePath(realpathSync.native(record.cwd), record.cwd)
      || !Number.isFinite(record.updatedAt)) throw new Error("Incompatible or foreign worker manifest");
    if (record.sessionFile !== undefined) {
      if (typeof record.sessionFile !== "string" || basename(record.sessionFile) !== record.sessionFile || /[\\/:]/.test(record.sessionFile) || !record.sessionFile.endsWith(".jsonl")) throw new Error("Invalid managed session path");
      const path = join(folder, record.sessionFile);
      plainFile(path);
      if (!samePath(realpathSync.native(dirname(path)), folder)) throw new Error("Managed session escaped its store");
    }
    if (record.systemHash !== undefined && (typeof record.systemHash !== "string" || !HASH.test(record.systemHash))) throw new Error("Invalid worker context fingerprint");
    if (record.sessionId !== undefined && (typeof record.sessionId !== "string" || !UUID.test(record.sessionId))) throw new Error("Invalid managed session identity");
    return record;
  }

  sessionPath(record: StoredWorker): string {
    if (!record.sessionFile || !record.sessionId || !record.systemHash) throw new Error("Worker has no complete persisted session");
    return join(this.sessionDirectory(record.owner, record.handle), record.sessionFile);
  }

  hasSessionLease(record: StoredWorker): boolean {
    return existsSync(join(this.sessionDirectory(record.owner, record.handle), "active.lock"));
  }

  acquireSession(record: StoredWorker): () => void {
    const release = this.lease(join(this.sessionDirectory(record.owner, record.handle), "active.lock"), record.handle);
    try {
      // A cold recovery may have waited while another runner advanced the file.
      // Compare only after claiming the lease, before any manifest state write.
      const current = this.load(record.owner, record.handle);
      if (JSON.stringify(current) !== JSON.stringify(record)) throw new Error("Stale worker manifest; reopen through a fresh runner");
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  acquireWriter(worktreeRoot: string, handle: string): () => void {
    if (!UUID.test(handle)) throw new Error("Invalid writer handle");
    const root = directory(resolve(this.root));
    const locks = directory(join(root, "writer-locks"));
    const canonical = realpathSync.native(worktreeRoot);
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    return this.lease(join(locks, `${workerHash(key)}.lock`), handle);
  }

  private lease(lock: string, handle: string): () => void {
    const token = randomUUID();
    try { writeFileSync(lock, JSON.stringify({ handle, token, pid: process.pid }), { flag: "wx", mode: 0o600 }); }
    catch { throw new Error("Worker session or worktree already leased or interrupted; inspect the prior process before explicit lock reconciliation"); }
    let released = false;
    return () => {
      if (released) return;
      plainFile(lock);
      const current = JSON.parse(readFileSync(lock, "utf8")) as { token?: unknown };
      if (current.token !== token) throw new Error("Writer lease ownership changed; refusing to release it");
      unlinkSync(lock);
      released = true;
    };
  }
}
