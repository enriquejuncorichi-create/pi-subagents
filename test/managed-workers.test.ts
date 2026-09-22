import { resolve } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { type ExtensionAPI, type ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import { registerRpcHandlers } from "../src/cross-extension-rpc.js";
import { canonicalDirectory, createWorkerRuntime, type ManagedRun, validateWorkerRoute, verifyWorkerWorkspace } from "../src/managed-worker-runtime.js";
import { ManagedWorkers } from "../src/managed-workers.js";

const native = openaiCodexProvider();
const model = native.getModels()[0];
const route = { provider: model.provider, model: model.id };
function fixture() {
  const registry = {
    find: vi.fn(() => model), getAvailable: vi.fn(() => [model]),
    getRegisteredProviderConfig: vi.fn(() => undefined), getRegisteredNativeProvider: vi.fn(() => undefined),
    isUsingOAuth: vi.fn(() => true), getProvider: vi.fn(() => native),
  };
  let owner = "owner-one";
  const ctx = { cwd: process.cwd(), model: { ...model, id: "parent" }, modelRegistry: registry,
    sessionManager: { getSessionId: () => owner }, getSystemPrompt: () => "Repository instructions" } as unknown as ExtensionContext;
  const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
  const manager = new AgentManager();
  managers.push(manager);
  const workers = new ManagedWorkers(pi, manager, () => ctx, async () => native);
  return { registry, ctx, pi, manager, workers, changeOwner: () => { owner = "owner-two"; },
    input: { requestId: "request", type: "general-purpose", prompt: "Inspect", route, cwd: process.cwd(), access: "read-only" as const } };
}
const managers: AgentManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) { manager.abortAll(); await manager.dispose(); } vi.restoreAllMocks(); });
registerAgents([]);

describe("managed worker fail-closed boundaries", () => {
  it("requires exact availability, subscription OAuth and native provenance", () => {
    const f = fixture();
    expect(validateWorkerRoute(f.ctx, route, native)).toEqual(model);
    f.registry.getAvailable.mockReturnValue([]);
    expect(() => validateWorkerRoute(f.ctx, route, native)).toThrow("unavailable");
    f.registry.getAvailable.mockReturnValue([model]);
    f.registry.isUsingOAuth.mockReturnValue(false);
    expect(() => validateWorkerRoute(f.ctx, route, native)).toThrow("subscription OAuth");
    f.registry.isUsingOAuth.mockReturnValue(true);
    f.registry.find.mockReturnValue({ ...model, baseUrl: "https://untrusted.invalid" });
    expect(() => validateWorkerRoute(f.ctx, route, native)).toThrow("provenance");
    expect(() => validateWorkerRoute(f.ctx, { provider: "anthropic", model: "x" }, native)).toThrow("billing-unverified");
  });

  it("rejects bad auth before constructing a runtime or spawning", async () => {
    const f = fixture();
    const create = vi.spyOn(ModelRuntime, "create");
    const spawn = vi.spyOn(f.manager, "spawn");
    f.registry.isUsingOAuth.mockReturnValue(false);
    await expect(f.workers.spawn(f.input)).rejects.toThrow("subscription OAuth");
    expect(spawn).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(f.ctx.model?.id).toBe("parent");
  });

  it("rejects unknown/stale handles without any model request", () => {
    const f = fixture();
    expect(() => f.workers.status({ requestId: "s", handle: "foreign" })).toThrow("stale");
    expect(() => f.workers.stop({ requestId: "s", handle: "foreign" })).toThrow("stale");
    expect(f.registry.find).not.toHaveBeenCalled();
  });

  it("rejects a write worker outside a verified linked worktree", async () => {
    const f = fixture();
    vi.mocked(f.pi.exec).mockResolvedValue({ code: 128, killed: false, stdout: "", stderr: "not a repository" });
    await expect(verifyWorkerWorkspace(f.pi, process.cwd(), canonicalDirectory(process.cwd()), "write")).rejects.toThrow("verify");
    expect(f.pi.exec).toHaveBeenCalledWith("git", ["-C", canonicalDirectory(process.cwd()), "rev-parse", "--show-toplevel"], { timeout: 10_000 });
  });

  it("advertises managed channels only when the service is installed", async () => {
    const f = fixture();
    const handlers = new Map<string, (data: unknown) => void>();
    const emit = vi.fn();
    const rpc = registerRpcHandlers({ events: { on: (name, handler) => { handlers.set(name, handler); return () => { handlers.delete(name); }; }, emit }, pi: f.pi, getCtx: () => f.ctx,
      manager: { spawn: vi.fn(), awaitStartup: async () => {}, abort: () => false, getRecord: () => undefined, consumeResult: () => false }, managedWorkers: f.workers });
    await handlers.get("subagents:rpc:ping")?.({ requestId: "p" });
    expect(emit).toHaveBeenCalledWith("subagents:rpc:ping:reply:p", { success: true, data: { version: 2, capabilities: ["managed-workers-v1"] } });
    expect(handlers.has("subagents:rpc:worker-resume")).toBe(true);
    rpc.unsubWorkers();
    expect(handlers.has("subagents:rpc:worker-resume")).toBe(false);
  });

  it("guards the downstream lazy native stream after preflight and disables native retries", async () => {
    const f = fixture();
    let provider: Provider | undefined;
    const downstream = vi.spyOn(native, "streamSimple");
    // Runtime composition is the seam: no auth file or provider requests are made.
    const runtime = {
      registerNativeProvider: (value: Provider) => { provider = value; },
      getAvailable: async () => [model], isUsingOAuth: () => true, refresh: async () => ({}),
      stream: vi.fn(), streamSimple: vi.fn(),
    } as unknown as ModelRuntime;
    vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
    const managed: ManagedRun = { route, native, cwd: resolve(process.cwd()), access: "read-only", maxTurns: 2, assertOwner: () => f.ctx, onSession: () => {} };
    const result = await createWorkerRuntime(managed);
    expect(result.model).toEqual(model);
    expect(provider?.auth.apiKey).toBeUndefined();
    f.registry.isUsingOAuth.mockReturnValue(false);
    expect(() => provider!.streamSimple(model, { messages: [] })).toThrow("subscription OAuth");
    expect(downstream).not.toHaveBeenCalled();
    expect(() => result.runtime.streamSimple({ ...model, id: "wrong" }, { messages: [] })).toThrow();
  });

  it("retains opaque ownership and refuses busy resume; omitted usage stays unknown", async () => {
    const f = fixture();
    const spawn = vi.spyOn(f.manager, "spawn").mockImplementation((_pi, _ctx, _type, _prompt, options) => {
      captured = options.managed;
      return "agent-one";
    });
    let captured: ManagedRun | undefined;
    const record = { id: "agent-one", status: "queued", session: undefined };
    vi.spyOn(f.manager, "getRecord").mockImplementation(() => record as ReturnType<AgentManager["getRecord"]>);
    const receipt = await f.workers.spawn(f.input);
    expect(receipt.handle).not.toBe("agent-one");
    expect(receipt).not.toHaveProperty("usage");
    expect(spawn.mock.calls[0][4]).toMatchObject({ isolated: true, isBackground: true });
    await expect(f.workers.resume({ requestId: "r", handle: receipt.handle, prompt: "Continue" })).rejects.toThrow("busy");
    f.changeOwner();
    expect(() => captured?.assertOwner()).toThrow("Foreign");
    expect(() => f.workers.stop({ requestId: "r", handle: receipt.handle })).toThrow("Foreign");
  });
});
