import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agent-manager.js";
import { getAvailableTypes } from "./agent-types.js";
import { canonicalDirectory, type ManagedRun, NativeWorkerCatalogue, validateWorkerRoute, verifyWorkerWorkspace, type WorkerRoute } from "./managed-worker-runtime.js";
import { ManagedWorkerStore, type StoredWorker, type WorkerOwner, workerHash } from "./managed-worker-store.js";
import type { ThinkingLevel } from "./types.js";

export const MANAGED_WORKERS_CAPABILITY = "managed-workers-v1";
export interface WorkerSpawn {
  requestId: string;
  type: string;
  prompt: string;
  route: WorkerRoute;
  cwd: string;
  access: "read-only" | "write";
  thinkingLevel?: ThinkingLevel | "off";
  maxTurns?: number;
  signal?: AbortSignal;
}
export interface WorkerRequest { requestId: string; handle: string; prompt?: string; signal?: AbortSignal }
interface Worker {
  handle: string;
  agentId: string;
  owner: string;
  workspace: string;
  managed: ManagedRun;
  sessionId?: string;
  stored?: StoredWorker;
  detachCancellation?: () => void;
}

/** Handles are deliberately process-local capabilities, never raw session paths. */
export class ManagedWorkers {
  private workers = new Map<string, Worker>();
  private epoch = 0;
  private catalogue = new NativeWorkerCatalogue();

  dispose(): void {
    this.epoch++;
    for (const worker of this.workers.values()) {
      this.abortWorker(worker);
      worker.detachCancellation?.();
    }
    this.workers.clear();
  }
  constructor(private pi: ExtensionAPI, private manager: AgentManager, private getCtx: () => ExtensionContext | undefined, private loadNative?: (route: WorkerRoute) => Promise<Provider>, private store = new ManagedWorkerStore(join(getAgentDir(), "managed-workers-v1")), private reserveRequest?: () => number) {}

  private persistentOwner(ctx: ExtensionContext): WorkerOwner | undefined {
    const file = ctx.sessionManager.getSessionFile?.();
    return file ? { id: ctx.sessionManager.getSessionId(), parentFile: realpathSync.native(file), workspace: canonicalDirectory(ctx.cwd) } : undefined;
  }

  private context(): ExtensionContext {
    const ctx = this.getCtx();
    if (!ctx?.sessionManager.getSessionId()) throw new Error("No active worker owner session");
    return ctx;
  }

  private owned(handle: string): Worker {
    const worker = this.workers.get(handle);
    if (!worker) throw new Error("Unknown or stale worker handle; restart restoration is not supported");
    worker.managed.assertOwner();
    if (!this.manager.getRecord(worker.agentId)) throw new Error("Stale worker handle; live session was evicted");
    return worker;
  }

  private receipt(worker: Worker) {
    const record = this.manager.getRecord(worker.agentId);
    if (!record) throw new Error("Stale worker handle");
    return {
      handle: worker.handle, agentId: worker.agentId, route: { ...worker.managed.route }, status: record.status,
      ...(worker.sessionId ? { sessionId: worker.sessionId } : {}),
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(worker.managed.usage ? { usage: { ...worker.managed.usage } } : {}),
    };
  }

  private persist(worker: Worker): void {
    // Append only to the owning session, never the session switched to afterwards.
    worker.managed.assertOwner();
    const { handle, agentId, route, status, sessionId } = this.receipt(worker);
    this.pi.appendEntry("subagents:managed-worker", {
      version: 1, owner: worker.owner, workspace: worker.workspace,
      handle, agentId, route, status, sessionId, cwd: worker.managed.cwd, access: worker.managed.access,
      restoration: worker.stored ? "owned-persistent-session" : "ephemeral-parent-stale-refusal",
    });
  }

  private abortWorker(worker: Worker): void {
    const neverStarted = this.manager.getRecord(worker.agentId)?.status === "queued" && !worker.stored?.sessionFile;
    this.manager.abort(worker.agentId);
    if (neverStarted && worker.stored) {
      worker.stored.state = "stopped";
      worker.stored.updatedAt = Date.now();
      this.store.save(worker.stored);
    }
  }

  private cancellation(worker: Worker, signal?: AbortSignal): void {
    worker.detachCancellation?.();
    worker.detachCancellation = undefined;
    if (!signal) return;
    const abort = () => { this.abortWorker(worker); };
    if (signal.aborted) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      worker.detachCancellation = () => signal.removeEventListener("abort", abort);
    }
  }

  async spawn(input: WorkerSpawn) { return this.spawnOwned(input); }

  private async spawnOwned(input: WorkerSpawn, restored?: StoredWorker) {
    const ctx = this.context();
    if (!input || typeof input.requestId !== "string" || !input.requestId || typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("Worker requestId and prompt are required");
    if (!getAvailableTypes().includes(input.type)) throw new Error("Unknown or disabled worker type");
    if (!input.route || typeof input.route.provider !== "string" || typeof input.route.model !== "string") throw new Error("Exact worker route required");
    if (input.access !== "read-only" && input.access !== "write") throw new Error("Invalid worker access");
    if (input.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(input.thinkingLevel)) throw new Error("Invalid worker thinking level");
    const thinkingLevel = input.thinkingLevel === "off" ? undefined : input.thinkingLevel;
    const maxTurns = input.maxTurns ?? 24;
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 128) throw new Error("Worker maxTurns must be an integer from 1 to 128");
    input.signal?.throwIfAborted();
    const owner = ctx.sessionManager.getSessionId();
    const workspace = canonicalDirectory(ctx.cwd);
    const cwd = canonicalDirectory(input.cwd);
    const route = Object.freeze({ provider: input.route.provider, model: input.route.model });
    const epoch = this.epoch;
    const assertOwner = () => {
      const current = this.context();
      if (epoch !== this.epoch || current.sessionManager.getSessionId() !== owner || canonicalDirectory(current.cwd) !== workspace) throw new Error("Foreign worker owner or workspace");
      return current;
    };
    const native = await (this.loadNative ? this.loadNative(route) : this.catalogue.get(route));
    assertOwner();
    input.signal?.throwIfAborted();
    validateWorkerRoute(ctx, route, native);
    await verifyWorkerWorkspace(this.pi, ctx.cwd, cwd, input.access);
    assertOwner();
    input.signal?.throwIfAborted();
    validateWorkerRoute(ctx, route, native);
    // Bounded receipts; only settled entries may be forgotten.
    for (const [handle, worker] of this.workers) {
      if (this.workers.size < 100) break;
      const record = this.manager.getRecord(worker.agentId);
      if (!record || (record.status !== "running" && record.status !== "queued" && !record.session?.isStreaming)) {
        worker.detachCancellation?.();
        this.workers.delete(handle);
      }
    }
    if (this.workers.size >= 100) throw new Error("Managed worker capacity reached");
    const handle = restored?.handle ?? randomUUID();
    if (this.workers.has(handle)) throw new Error("Worker is already active in this runner");
    const persistentOwner = this.persistentOwner(ctx);
    const stored: StoredWorker | undefined = restored ?? (persistentOwner ? {
      version: 1, owner: persistentOwner, handle, type: input.type, route, cwd, access: input.access,
      thinking: thinkingLevel, maxTurns, state: "starting", updatedAt: Date.now(),
    } : undefined);
    if (restored && JSON.stringify(restored.owner) !== JSON.stringify(persistentOwner)) throw new Error("Foreign persisted worker owner");
    let recordedAllowance = 0;
    const worker: Worker = {
      handle, agentId: "", owner, workspace, stored,
      managed: {
        route, native, cwd, access: input.access, maxTurns, assertOwner, reserveRequest: this.reserveRequest,
        onAllowance: observation => {
          assertOwner();
          if (recordedAllowance >= 32) return;
          recordedAllowance++;
          this.pi.appendEntry("subagents:managed-allowance", {
            owner, handle, route, observation, sequence: recordedAllowance,
            observationLimit: 32, limitReached: recordedAllowance === 32,
          });
        },
        sessionDirectory: stored ? this.store.sessionDirectory(stored.owner, handle) : undefined,
        resumeSessionFile: restored ? this.store.sessionPath(restored) : undefined,
        expectedSessionId: restored?.sessionId,
        expectedSystemHash: restored?.systemHash,
        acquireWriter: root => this.store.acquireWriter(root, handle),
        acquireSession: stored ? () => this.store.acquireSession(stored) : undefined,
        onState: state => {
          if (stored) { stored.state = state; stored.updatedAt = Date.now(); this.store.save(stored); }
        },
        onSession: (session: AgentSession) => {
          worker.sessionId = session.sessionManager.getSessionId();
          if (stored) {
            const file = session.sessionManager.getSessionFile();
            if (!file) throw new Error("Managed worker persistence unavailable");
            stored.sessionFile = basename(file);
            stored.sessionId = worker.sessionId;
            stored.systemHash = workerHash(session.systemPrompt);
            this.store.save(stored);
          }
          session.subscribe(event => { if (event.type === "agent_end") worker.detachCancellation?.(); });
          this.persist(worker);
        },
      },
    };
    if (stored && !restored) this.store.save(stored);
    worker.agentId = this.manager.spawn(this.pi, ctx, input.type, input.prompt, {
      model: validateWorkerRoute(ctx, route, native),
      description: `Managed ${input.type}`, isBackground: true, cwd, isolated: true,
      thinkingLevel, maxTurns, signal: input.signal, managed: worker.managed,
    });
    this.workers.set(worker.handle, worker);
    this.cancellation(worker, input.signal);
    try { this.persist(worker); } catch (error) { this.manager.abort(worker.agentId); throw error; }
    return this.receipt(worker);
  }

  async resume(input: WorkerRequest) {
    if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("Worker resume prompt is required");
    if (!this.workers.has(input.handle)) {
      const owner = this.persistentOwner(this.context());
      if (!owner) throw new Error("Unknown or stale worker handle; parent session is ephemeral");
      const saved = this.store.load(owner, input.handle);
      if (saved.state === "starting" || saved.state === "running") throw new Error("Worker was interrupted; inspect its work and reconcile any writer lease before a fresh dispatch. No prompt replay attempted");
      return this.spawnOwned({ requestId: input.requestId, type: saved.type, prompt: input.prompt, route: saved.route, cwd: saved.cwd, access: saved.access, thinkingLevel: saved.thinking, maxTurns: saved.maxTurns, signal: input.signal }, saved);
    }
    const worker = this.owned(input.handle);
    validateWorkerRoute(worker.managed.assertOwner(), worker.managed.route, worker.managed.native);
    input.signal?.throwIfAborted();
    if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("Worker resume prompt is required");
    const record = this.manager.getRecord(worker.agentId)!;
    if (record.status === "running" || record.status === "queued" || record.session?.isStreaming || worker.managed.busy) throw new Error("Worker handle is busy");
    if (!record.session) throw new Error("Stale worker handle; no live session to resume");
    const pendingResume = this.manager.resume(worker.agentId, input.prompt, undefined, { isBackground: true });
    // manager.resume claims its queue/run synchronously. Attach before yielding,
    // including when the RPC deadline expires before the receipt is delivered.
    this.cancellation(worker, input.signal);
    try {
      const resumed = await pendingResume;
      if (!resumed) throw new Error("Worker handle is busy or stale");
      this.persist(worker);
      return this.receipt(worker);
    } catch (error) {
      worker.detachCancellation?.();
      worker.detachCancellation = undefined;
      this.manager.abort(worker.agentId);
      throw error;
    }
  }

  status(input: WorkerRequest) {
    if (!this.workers.has(input.handle)) {
      const ctx = this.context();
      const owner = this.persistentOwner(ctx);
      if (!owner) throw new Error("Unknown or stale worker handle");
      const saved = this.store.load(owner, input.handle);
      const status = ["starting", "running"].includes(saved.state) || this.store.hasSessionLease(saved) ? "interrupted" : saved.state;
      // A completed cold session is resumable, not a provider failure. The
      // persisted agent id signals that no live agent has been created yet.
      return { handle: saved.handle, agentId: `persisted-${saved.handle}`, route: saved.route, status, sessionId: saved.sessionId,
        ...(status === "completed" ? {} : { error: "Persisted worker is not completed; inspect and reconcile before fresh dispatch" }) };
    }
    const worker = this.owned(input.handle);
    validateWorkerRoute(worker.managed.assertOwner(), worker.managed.route, worker.managed.native);
    return this.receipt(worker);
  }

  stop(input: WorkerRequest) {
    const worker = this.owned(input.handle);
    // Revoked authentication must not prevent cancelling already-owned work.
    this.abortWorker(worker);
    this.persist(worker);
    return this.receipt(worker);
  }
}
