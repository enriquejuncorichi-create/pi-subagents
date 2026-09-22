import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, AssistantMessageEventStream, InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import * as codex from "@earendil-works/pi-ai/providers/openai-codex";
import { AgentSession, type ExtensionAPI, type ExtensionContext, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import * as allowance from "../src/managed-allowance.js";
import { canonicalDirectory } from "../src/managed-worker-runtime.js";
import { ManagedWorkerStore, type StoredWorker } from "../src/managed-worker-store.js";
import { ManagedWorkers } from "../src/managed-workers.js";

const managers: AgentManager[] = [];
const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) { manager.abortAll(); await manager.dispose(); }
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class RetainedLeaseStore extends ManagedWorkerStore {
  failRelease = false;
  releaseAttempts = 0;
  override acquireSession(record: StoredWorker): () => void {
    const release = super.acquireSession(record);
    return () => {
      this.releaseAttempts++;
      if (this.failRelease) throw new Error("Synthetic session release failure");
      release();
    };
  }
}

async function harness(persistent = false) {
  registerAgents([]);
  const native = codex.openaiCodexProvider();
  const model = native.getModels()[0];
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(model.provider, async () => ({ type: "oauth", access: "test-only", refresh: "test-only", expires: Date.now() + 86400000 }));
  let hold = false;
  let oauth = true;
  let providerError = false;
  let responseHeaders: Record<string, string> | undefined;
  const pending: (() => void)[] = [];
  const stream = vi.fn<Provider["streamSimple"]>((actual, _context, options) => {
    const events = new AssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant", content: [{ type: "text", text: "Verified response" }], api: actual.api,
      provider: actual.provider, model: actual.id, timestamp: Date.now(), stopReason: "stop",
      usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const finish = async () => {
      try {
        if (responseHeaders !== undefined) await options?.onResponse?.({ status: 200, headers: responseHeaders }, actual);
        await options?.onPayload?.({ synthetic: true }, actual);
      } catch (error) {
        message.stopReason = "error";
        message.errorMessage = String(error);
        events.push({ type: "error", reason: "error", error: message });
        events.end(message);
        return;
      }
      if (providerError) {
        message.stopReason = "error";
        message.errorMessage = "Synthetic primary provider failure";
        events.push({ type: "error", reason: "error", error: message });
      } else events.push({ type: "done", reason: "stop", message });
      events.end(message);
    };
    if (hold) { pending.push(finish); options?.signal?.addEventListener("abort", finish, { once: true }); }
    else queueMicrotask(finish);
    return events;
  });
  const provider: Provider = { ...native, auth: { oauth: { ...native.auth.oauth!, toAuth: async () => ({ auth: { apiKey: "test-only" }, source: "OAuth" }) } }, streamSimple: stream, stream };
  vi.spyOn(codex, "openaiCodexProvider").mockReturnValue(provider);
  const create = ModelRuntime.create.bind(ModelRuntime);
  vi.spyOn(ModelRuntime, "create").mockImplementation(options => create({ ...options, credentials }));
  let owner = "one";
  const root = persistent ? realpathSync.native(mkdtempSync(join(tmpdir(), "managed-runtime-test-"))) : undefined;
  if (root) temporaryRoots.push(root);
  const parent = root ? SessionManager.create(root, join(root, "parents")) : undefined;
  // The SDK materialises a parent transcript once it contains an assistant reply.
  parent?.appendMessage({ role: "assistant", content: [{ type: "text", text: "Synthetic parent" }],
    api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const store = root ? new RetainedLeaseStore(join(root, "store")) : undefined;
  const persistentOwner = parent ? { id: parent.getSessionId(), parentFile: realpathSync.native(parent.getSessionFile()!), workspace: canonicalDirectory(root!) } : undefined;
  const ctx = {
    cwd: root ?? process.cwd(), model: { ...model, id: "parent-model" },
    getSystemPrompt: () => "Obey repository instructions.",
    sessionManager: parent ?? { getSessionId: () => owner },
    modelRegistry: { find: () => model, getAvailable: () => [model], isUsingOAuth: () => oauth,
      getProvider: () => provider, getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined },
  } as unknown as ExtensionContext;
  const completed = vi.fn();
  const manager = new AgentManager(completed, 1);
  managers.push(manager);
  const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
  const workers = new ManagedWorkers(pi, manager, () => ctx, async () => provider, store);
  const cold = () => {
    const coldManager = new AgentManager();
    managers.push(coldManager);
    return new ManagedWorkers(pi, coldManager, () => ctx, async () => provider, store);
  };
  return { workers, manager, ctx, stream, credentials, completed, pi, store, persistentOwner, cold,
    setResponseHeaders: (headers: Record<string, string>) => { responseHeaders = headers; },
    failProvider: () => { providerError = true; },
    setHold: () => { hold = true; }, finish: () => { hold = false; for (const done of pending.splice(0)) done(); },
    revoke: () => { oauth = false; }, changeOwner: () => { owner = "two"; },
    input: { requestId: "spawn", type: "general-purpose", prompt: "Inspect", access: "read-only" as const, cwd: root ?? process.cwd(), route: { provider: model.provider, model: model.id } },
  };
}

describe("real managed SDK session and manager", () => {
  it("runs native runtime prompt, keeps tools and session on resume, leaves parent unchanged", async () => {
    const h = await harness();
    const receipt = await h.workers.spawn({ ...h.input, maxTurns: 1 });
    await h.manager.waitForAll();
    const record = h.manager.getRecord(receipt.agentId)!;
    expect(record.lifetimeUsage).toMatchObject({ input: 5, output: 2 });
    expect(record.error).toBeUndefined();
    expect(record.status).toBe("completed");
    expect(record.result).toBe("Verified response");
    const session = record.session!;
    expect(session.getActiveToolNames().sort()).toEqual(["find", "grep", "ls", "read"]);
    const first = h.workers.status({ requestId: "status", handle: receipt.handle });
    expect(first.sessionId).toBe(session.sessionManager.getSessionId());
    expect(first.usage).toEqual({ input: 5, output: 2, cacheRead: 0, cacheWrite: 0 });
    await h.workers.resume({ requestId: "resume", handle: receipt.handle, prompt: "Continue" });
    await h.manager.waitForAll();
    expect(record.session).toBe(session);
    expect(record.lifetimeUsage).toMatchObject({ input: 10, output: 4 });
    expect(h.workers.status({ requestId: "totals", handle: receipt.handle }).usage).toMatchObject({ input: 10, output: 4 });
    expect(h.stream).toHaveBeenCalledTimes(2);
    expect(h.stream.mock.calls.every(call => call[2]?.maxRetries === 0 && call[2]?.transport === "sse")).toBe(true);
    expect(h.ctx.model?.id).toBe("parent-model");
    expect(h.completed).toHaveBeenCalledTimes(2);
    expect(h.pi.appendEntry).toHaveBeenCalledWith("subagents:managed-worker", expect.objectContaining({ restoration: "ephemeral-parent-stale-refusal", sessionId: first.sessionId }));
  });

  it("persists only normalised account allowance snapshots, never raw auth headers", async () => {
    const h = await harness();
    const resetSeconds = Math.floor(Date.now() / 1000) + 60;
    h.setResponseHeaders({
      "X-Codex-Primary-Used-Percent": "12.5", "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(resetSeconds), authorization: "Bearer synthetic-secret",
      "set-cookie": "synthetic-cookie", "x-account-id": "synthetic-account",
    });
    const receipt = await h.workers.spawn(h.input);
    await h.manager.waitForAll();
    expect(h.manager.getRecord(receipt.agentId)?.status).toBe("completed");
    const entries = vi.mocked(h.pi.appendEntry).mock.calls.filter(([type]) => type === "subagents:managed-allowance");
    expect(entries).toEqual([["subagents:managed-allowance", {
      owner: "one", handle: receipt.handle, route: h.input.route, sequence: 1, observationLimit: 32, limitReached: false,
      observation: {
        scope: "account-window", ...h.input.route, observedAt: expect.any(Number), source: "codex-response-headers",
        windows: [{ family: "codex", window: "primary", usedPercent: 12.5, windowMinutes: 300, resetsAt: resetSeconds * 1000 }],
        invalid: false, attribution: "unknown",
      },
    }]]);
    const persisted = JSON.stringify(vi.mocked(h.pi.appendEntry).mock.calls);
    for (const secret of ["authorization", "synthetic-secret", "set-cookie", "synthetic-cookie", "synthetic-account", "x-codex"]) {
      expect(persisted).not.toContain(secret);
    }
  });

  it.each(["stream", "streamSimple"] as const)("composes and awaits onResponse once, strips onPayload and pins transport through %s", async method => {
    const h = await harness();
    const receipt = await h.workers.spawn(h.input);
    await h.manager.waitForAll();
    const session = h.manager.getRecord(receipt.agentId)!.session!;
    h.setResponseHeaders({});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const onResponse = vi.fn(async () => { await gate; });
    const onPayload = vi.fn(() => ({ mutated: true }));
    const result = session.modelRuntime[method](session.model!, { messages: [] }, { onResponse, onPayload, maxRetries: 9, transport: "auto" }).result();
    let settled = false;
    void result.then(() => { settled = true; });
    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(onResponse).toHaveBeenCalledWith({ status: 200, headers: {} }, session.model);
    release();
    expect((await result).stopReason).toBe("stop");
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onPayload).not.toHaveBeenCalled();
    expect(h.stream).toHaveBeenCalledTimes(2);
    for (const call of h.stream.mock.calls) {
      expect(call[2]).toMatchObject({ onPayload: undefined, maxRetries: 0, transport: "sse" });
    }
    expect(h.pi.appendEntry).toHaveBeenCalledWith("subagents:managed-allowance", expect.objectContaining({
      observation: expect.objectContaining({ source: "unavailable", windows: [], attribution: "unknown", invalid: false }),
    }));
  });

  it.each(["stream", "streamSimple"] as const)("rejects request auth/config overrides before %s reaches native", async method => {
    const h = await harness();
    const receipt = await h.workers.spawn(h.input);
    await h.manager.waitForAll();
    const session = h.manager.getRecord(receipt.agentId)!.session!;
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const options of [{ fetch }, { apiKey: "synthetic" }, { env: {} }, { headers: {} }, { baseUrl: "https://example.invalid" }]) {
      expect(() => session.modelRuntime[method](session.model!, { messages: [] }, options)).toThrow("overrides are forbidden");
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it.each(["sink", "parser"] as const)("does not fail requests or skip the previous callback when the allowance %s throws", async failure => {
    const h = await harness();
    const receipt = await h.workers.spawn(h.input);
    await h.manager.waitForAll();
    const session = h.manager.getRecord(receipt.agentId)!.session!;
    h.setResponseHeaders({});
    if (failure === "sink") {
      vi.mocked(h.pi.appendEntry).mockImplementation(type => {
        if (type === "subagents:managed-allowance") throw new Error("Synthetic sink failure");
      });
    } else vi.spyOn(allowance, "observeAllowance").mockImplementation(() => { throw new Error("Synthetic parser failure"); });
    for (const method of ["stream", "streamSimple"] as const) {
      const onResponse = vi.fn(async () => {});
      const result = await session.modelRuntime[method](session.model!, { messages: [] }, { onResponse }).result();
      expect(result.stopReason).toBe("stop");
      expect(onResponse).toHaveBeenCalledTimes(1);
    }
    expect(h.stream).toHaveBeenCalledTimes(3);
  });

  it("announces the 32-entry observation cap per live worker without blocking later requests", async () => {
    const h = await harness();
    h.setResponseHeaders({});
    const receipt = await h.workers.spawn(h.input);
    await h.manager.waitForAll();
    const session = h.manager.getRecord(receipt.agentId)!.session!;
    for (let i = 0; i < 33; i++) {
      expect((await session.modelRuntime.streamSimple(session.model!, { messages: [] }).result()).stopReason).toBe("stop");
    }
    const entries = vi.mocked(h.pi.appendEntry).mock.calls.filter(([type]) => type === "subagents:managed-allowance");
    expect(entries).toHaveLength(32);
    entries.forEach(([, data], index) => {
      expect(data).toMatchObject({
        handle: receipt.handle, sequence: index + 1, observationLimit: 32, limitReached: index === 31,
      });
    });
    expect(h.stream).toHaveBeenCalledTimes(34);
    const sibling = await h.workers.spawn(h.input);
    await h.manager.waitForAll();
    expect(h.pi.appendEntry).toHaveBeenLastCalledWith("subagents:managed-allowance", expect.objectContaining({
      handle: sibling.handle, sequence: 1, limitReached: false,
    }));
  });

  it("never creates ordinary resurrection tombstones for managed transcripts", async () => {
    const h = await harness();
    const receipt = await h.workers.spawn(h.input);
    await h.manager.waitForAll();
    const record = h.manager.getRecord(receipt.agentId)!;
    record.handle = "managed-test";
    record.sessionFile = "synthetic-managed-session.jsonl";
    h.manager.clearCompleted();
    expect(h.manager.getRecord(receipt.agentId)).toBeUndefined();
    expect(h.manager.listTombstones()).toEqual([]);
  });

  it("does not expose a resumable session when persistence registration fails", async () => {
    const h = await harness();
    vi.mocked(h.pi.appendEntry).mockImplementation((_type, data) => {
      if ((data as { sessionId?: string }).sessionId) throw new Error("Registration failed");
    });
    const receipt = await h.workers.spawn(h.input);
    await h.manager.waitForAll();
    const record = h.manager.getRecord(receipt.agentId)!;
    expect(record.status).toBe("error");
    expect(record.error).toContain("Registration failed");
    expect(record.session).toBeUndefined();
    await expect(h.workers.resume({ requestId: "r", handle: receipt.handle, prompt: "Again" })).rejects.toThrow("no live session");
    expect(h.stream).not.toHaveBeenCalled();
  });

  it("rejects an SDK-clamped thinking level before the provider is called", async () => {
    const h = await harness();
    vi.spyOn(AgentSession.prototype, "thinkingLevel", "get").mockReturnValue("high");
    const receipt = await h.workers.spawn({ ...h.input, thinkingLevel: "low" });
    await h.manager.waitForAll();
    const record = h.manager.getRecord(receipt.agentId)!;
    expect(record.status).toBe("error");
    expect(record.error).toContain("thinking mismatch");
    expect(record.session).toBeUndefined();
    expect(h.stream).not.toHaveBeenCalled();
  });

  it("auth revocation blocks resume and summary streams before the native boundary", async () => {
    const h = await harness();
    const receipt = await h.workers.spawn(h.input);
    await h.manager.waitForAll();
    h.revoke();
    await expect(h.workers.resume({ requestId: "r", handle: receipt.handle, prompt: "Again" })).rejects.toThrow("subscription OAuth");
    const session = h.manager.getRecord(receipt.agentId)!.session!;
    await expect(session.compact()).rejects.toThrow();
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it("stops queued and running workers through dispatch signals without touching siblings", async () => {
    const h = await harness();
    h.setHold();
    const runningSignal = new AbortController();
    const first = await h.workers.spawn({ ...h.input, signal: runningSignal.signal });
    await vi.waitFor(() => expect(h.stream).toHaveBeenCalledTimes(1));
    const queuedSignal = new AbortController();
    const second = await h.workers.spawn({ ...h.input, signal: queuedSignal.signal });
    expect(h.manager.getRecord(second.agentId)?.status).toBe("queued");
    queuedSignal.abort();
    expect(h.manager.getRecord(second.agentId)?.status).toBe("stopped");
    expect(h.manager.getRecord(first.agentId)?.status).toBe("running");
    runningSignal.abort();
    h.finish();
    await h.manager.waitForAll();
    expect(h.manager.getRecord(first.agentId)?.status).toBe("stopped");
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it("stores a queued persistent initial worker as stopped without creating its session", async () => {
    const h = await harness(true);
    h.setHold();
    const first = await h.workers.spawn(h.input);
    await vi.waitFor(() => expect(h.stream).toHaveBeenCalledTimes(1));
    const queued = await h.workers.spawn({ ...h.input, prompt: "Must never reach the provider" });
    expect(h.manager.getRecord(queued.agentId)?.status).toBe("queued");
    expect(h.store!.load(h.persistentOwner!, queued.handle).sessionFile).toBeUndefined();
    expect(h.workers.stop({ requestId: "stop-queued", handle: queued.handle }).status).toBe("stopped");
    const saved = h.store!.load(h.persistentOwner!, queued.handle);
    expect(saved.state).toBe("stopped");
    expect(saved.sessionFile).toBeUndefined();
    expect(saved.sessionId).toBeUndefined();
    expect(h.manager.getRecord(queued.agentId)?.session).toBeUndefined();
    expect(h.cold().status({ requestId: "cold-queued", handle: queued.handle }).status).toBe("stopped");
    expect(h.manager.getRecord(first.agentId)?.status).toBe("running");
    h.finish();
    await h.manager.waitForAll();
    expect(h.manager.getRecord(first.agentId)?.status).toBe("completed");
    expect(h.store!.load(h.persistentOwner!, queued.handle).state).toBe("stopped");
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect(h.stream.mock.calls.some(call => call[1].messages.some(message =>
      message.role === "user" && message.content === "Must never reach the provider"))).toBe(false);
  });

  it.each(["initial", "resume"] as const)("preserves a thrown prompt error alongside release failure on %s", async phase => {
    const h = await harness(true);
    const primary = new Error("Synthetic primary prompt failure");
    let rejectPrompt = phase === "initial";
    const originalPrompt = AgentSession.prototype.prompt;
    vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession, ...args: Parameters<AgentSession["prompt"]>) {
      await originalPrompt.apply(this, args);
      if (rejectPrompt) throw primary;
    });
    let handle: string;
    if (phase === "resume") {
      const receipt = await h.workers.spawn(h.input);
      await h.manager.waitForAll();
      handle = receipt.handle;
      rejectPrompt = true;
      h.store!.failRelease = true;
      const session = h.manager.getRecord(receipt.agentId)!.session!;
      await expect(session.prompt("Continue")).rejects.toSatisfy((error: unknown) =>
        error instanceof AggregateError && error.errors.includes(primary)
        && error.errors.some((item: unknown) => item instanceof Error && item.message === "Synthetic session release failure"));
    } else {
      h.store!.failRelease = true;
      const receipt = await h.workers.spawn(h.input);
      handle = receipt.handle;
      await h.manager.waitForAll();
      expect(h.manager.getRecord(receipt.agentId)?.status).toBe("error");
      expect(h.manager.getRecord(receipt.agentId)?.error).toContain(primary.message);
      expect(h.manager.getRecord(receipt.agentId)?.error).toContain("Synthetic session release failure");
    }
    expect(h.store!.load(h.persistentOwner!, handle).state).toBe("error");
    expect(h.store!.hasSessionLease(h.store!.load(h.persistentOwner!, handle))).toBe(true);
    expect(h.cold().status({ requestId: "retained", handle }).status).toBe("interrupted");
    expect(h.store!.releaseAttempts).toBe(phase === "resume" ? 2 : 1);
    expect(h.stream).toHaveBeenCalledTimes(phase === "resume" ? 2 : 1);
  });

  it("preserves provider stopReason:error when releasing the session lease also fails", async () => {
    const h = await harness(true);
    h.failProvider();
    h.store!.failRelease = true;
    const receipt = await h.workers.spawn(h.input);
    await h.manager.waitForAll();
    const record = h.manager.getRecord(receipt.agentId)!;
    expect(record.status).toBe("error");
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect(h.store!.load(h.persistentOwner!, receipt.handle).state).toBe("error");
    expect(h.cold().status({ requestId: "retained-provider-error", handle: receipt.handle }).status).toBe("interrupted");
    expect(record.error).toContain("Synthetic session release failure");
    expect(record.error).toContain("Synthetic primary provider failure");
  });

  it("does not fall back to a stored API key after OAuth preflight", async () => {
    const h = await harness();
    const receipt = await h.workers.spawn(h.input);
    await h.manager.waitForAll();
    await h.credentials.modify(h.input.route.provider, async () => ({ type: "api_key", key: "test-only-paid-key" }));
    await h.workers.resume({ requestId: "r", handle: receipt.handle, prompt: "Again" });
    await h.manager.waitForAll();
    expect(h.manager.getRecord(receipt.agentId)?.status).toBe("error");
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it("detaches cancellation on a rejected resume and still permits stop after auth revocation", async () => {
    const h = await harness();
    const receipt = await h.workers.spawn(h.input);
    await h.manager.waitForAll();
    const signal = new AbortController();
    const remove = vi.spyOn(signal.signal, "removeEventListener");
    vi.spyOn(h.manager, "resume").mockRejectedValue(new Error("resume rejected"));
    await expect(h.workers.resume({ requestId: "r", handle: receipt.handle, prompt: "Continue", signal: signal.signal })).rejects.toThrow("resume rejected");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    h.revoke();
    expect(() => h.workers.stop({ requestId: "stop", handle: receipt.handle })).not.toThrow();
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it("refuses foreign ownership and stale restart handles", async () => {
    const h = await harness();
    const receipt = await h.workers.spawn(h.input);
    await h.manager.waitForAll();
    h.changeOwner();
    await expect(h.workers.resume({ requestId: "r", handle: receipt.handle, prompt: "Again" })).rejects.toThrow("Foreign");
    h.workers.dispose();
    expect(() => h.workers.status({ requestId: "s", handle: receipt.handle })).toThrow("stale");
    expect(h.stream).toHaveBeenCalledTimes(1);
  });
});
