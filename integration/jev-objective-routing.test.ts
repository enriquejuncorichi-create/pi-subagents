import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { AssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Provider } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { WorkerBus, WorkerReceipt } from "../../pi-jev-assist/src/worker-client.js";
import type { Qualification } from "../../pi-jev-assist/src/worker-routing.js";
import type { WorkerPolicy } from "../../pi-jev-assist/src/worker-task-contract.js";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import { registerRpcHandlers } from "../src/cross-extension-rpc.js";
import { ManagedWorkers } from "../src/managed-workers.js";

// Staging-only sibling integration, not a released package/dependency contract.
// JEV_ASSIST_CHECKOUT overrides the installed sibling for staging tests.
// Real: installed Jev tool, WorkerClient, RPC, managed ownership/provenance guards,
// AgentManager and SDK sessions. Synthetic: classifier, trusted qualification,
// in-memory OAuth and native provider responses. No live inference or credentials.
const checkout = resolve(process.env.JEV_ASSIST_CHECKOUT ?? fileURLToPath(new URL("../../pi-jev-assist/", import.meta.url)));
const { installWorkerRouting } = await import(pathToFileURL(resolve(checkout, "src/worker-extension.ts")).href) as typeof import("../../pi-jev-assist/src/worker-extension.js");

test("installed objective routing crosses RPC into a qualified cross-provider SDK session and fails closed", async () => {
  const credentials = new InMemoryCredentialStore();
  const originalCreate = ModelRuntime.create;
  const catalogue = await originalCreate.call(ModelRuntime, { credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const codex = catalogue.getProvider("openai-codex");
  const xai = catalogue.getProvider("xai");
  assert.ok(codex?.auth.oauth?.isSubscription);
  assert.ok(xai?.auth.oauth?.isSubscription);
  const parentModel = codex.getModels().find(model => model.reasoning && model.contextWindow >= 32_000);
  const workerModel = xai.getModels().find(model => model.reasoning && model.contextWindow >= 32_000);
  assert.ok(parentModel, "Native Codex catalogue must supply the exact parent model");
  assert.ok(workerModel, "Native xai catalogue must supply the exact reasoning worker model");
  const baseline = { provider: parentModel.provider, model: parentModel.id };
  const route = { provider: workerModel.provider, model: workerModel.id };
  const routeKey = `${route.provider}/${route.model}`;
  for (const provider of [codex, xai]) {
    await credentials.modify(provider.id, async () => ({ type: "oauth", access: "synthetic-objective-test", refresh: "synthetic-objective-test", expires: Date.now() + 86_400_000 }));
  }
  const calls: Array<{ model: Parameters<Provider["streamSimple"]>[0]; options: Parameters<Provider["streamSimple"]>[2] }> = [];
  const stream: Provider["streamSimple"] = (actual, _context, options) => {
    calls.push({ model: actual, options });
    assert.deepEqual(actual, workerModel, "The actual provider stream must receive the exact native xai model");
    assert.equal(options?.reasoning, "low");
    const events = new AssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant", provider: actual.provider, model: actual.id, api: actual.api,
      content: [{ type: "text", text: `Synthetic source-impact evidence ${calls.length}` }],
      stopReason: "stop", timestamp: Date.now(),
      usage: { input: 8, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(() => { events.push({ type: "done", reason: "stop", message }); events.end(message); });
    return events;
  };
  const providers = new Map([codex, xai].map(native => [native.id, {
    ...native,
    auth: { oauth: { ...native.auth.oauth!, toAuth: async () => ({ apiKey: "synthetic-objective-test" }) } },
    stream, streamSimple: stream,
  } satisfies Provider]));
  const spawnRequests: Array<{ maxTurns: number; thinkingLevel: string; route: unknown }> = [];
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const bus: WorkerBus = {
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener); listeners.set(channel, set);
      return () => { set.delete(listener); if (!set.size) listeners.delete(channel); };
    },
    emit(channel, data) {
      if (channel === "subagents:rpc:worker-spawn") spawnRequests.push(data as typeof spawnRequests[number]);
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(data);
    },
  };
  const lifecycle = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  type Tool = { name: string; execute(id: string, args: { action: "start" | "resume" | "status"; task?: string; role?: "scout"; taskKey?: string; handle?: string }, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<unknown> };
  let tool: Tool | undefined;
  const entries: Array<{ name: string; data: unknown }> = [];
  let setModelCalls = 0;
  let setThinkingCalls = 0;
  let available = [parentModel, workerModel];
  const ctx = {
    cwd: fileURLToPath(new URL("../", import.meta.url)), model: parentModel,
    sessionManager: { getSessionId: () => "synthetic-objective-parent", getBranch: () => [] },
    getSystemPrompt: () => "Locate only the supplied bounded source impact. Responses in this test are synthetic.",
    modelRegistry: {
      find: (provider: string, id: string) => [parentModel, workerModel].find(model => model.provider === provider && model.id === id),
      getAvailable: () => available,
      isUsingOAuth: () => true,
      getProvider: (provider: string) => providers.get(provider),
      getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined,
    },
  } as unknown as ExtensionContext;
  const pi = {
    events: bus,
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => lifecycle.set(event, handler),
    registerTool: (registered: Tool) => { assert.equal(registered.name, "jev_worker"); tool = registered; },
    appendEntry: (name: string, data: unknown) => entries.push({ name, data }),
    getThinkingLevel: () => "low",
    setModel: () => { setModelCalls++; throw new Error("Parent model must never be set"); },
    setThinkingLevel: () => { setThinkingCalls++; throw new Error("Parent thinking must never be set"); },
    exec: () => { throw new Error("Read-only synthetic task must not execute shell commands"); },
  } as unknown as ExtensionAPI;
  let family = "source-impact-location";
  let evaluations = 0;
  const service = {
    evaluate: async (request: { questions: Record<string, unknown> }) => {
      evaluations++;
      assert.deepEqual(Object.keys(request.questions).sort(), ["freshContext", "needsReasoning", "needsVision", "risk", "roleFits", "taskFamily"]);
      return { ok: true as const, answers: {
        risk: { choice: "routine", confidence: 0.99 }, roleFits: { noul: 0.99 }, freshContext: { noul: 0.01 },
        taskFamily: { choice: family, confidence: 0.99 }, needsVision: { noul: 0.01 }, needsReasoning: { noul: 0.01 },
      } };
    },
  } as unknown as Parameters<typeof installWorkerRouting>[1];
  // Explicitly injected synthetic evidence tests routing mechanics, not benchmark
  // validity, qualification import/trust, real latency, quality or billing.
  let qualifications: Qualification[] = [{
    route, baseline, roles: ["scout"], evidenceRef: "synthetic:test-only:source-impact-location",
    suiteHash: "a".repeat(64), expiresAt: Date.now() + 86_400_000,
    qualityPassed: true, endToEnd: true, medianAcceptedMs: 500, baselineMedianAcceptedMs: 1000,
    taskEvidence: [{ family: "source-impact-location", acceptedSamples: 3, medianAcceptedMs: 500, baselineMedianAcceptedMs: 1000 }],
  }];
  let policy: WorkerPolicy = { mode: "prefer-other-provider" };
  registerAgents([]);
  const manager = new AgentManager();
  const workers = new ManagedWorkers(pi, manager, () => ctx, async selected => {
    const provider = providers.get(selected.provider);
    assert.ok(provider);
    return provider;
  });
  const rpc = registerRpcHandlers({ events: bus, pi, getCtx: () => ctx, managedWorkers: workers, manager: {
    spawn: () => { throw new Error("Legacy spawn must not be used"); }, awaitStartup: async () => {},
    abort: id => manager.abort(id), getRecord: id => manager.getRecord(id), consumeResult: () => false,
  } });
  // Sole runtime monkeypatch: real SDK runtime creation with isolated credentials.
  ModelRuntime.create = options => originalCreate.call(ModelRuntime, { ...options, credentials });
  try {
    installWorkerRouting(pi, service, { enabled: () => true, setEnabled: () => {}, exclusions: () => [], qualifications: () => qualifications, policy: () => policy });
    await lifecycle.get("session_start")!({}, ctx);
    assert.ok(tool);
    const execute = (args: Parameters<Tool["execute"]>[1]) => tool!.execute("synthetic-call", args, undefined, undefined, ctx);
    const latestReceipt = (): WorkerReceipt => {
      const entry = entries.filter(entry => entry.name === "jev-worker-record").at(-1);
      assert.ok(entry);
      return (entry.data as { receipt: WorkerReceipt }).receipt;
    };
    const task = { action: "start" as const, role: "scout" as const, taskKey: "source-impact-owned", task: "Locate the caller of the supplied source symbol; report bounded source-impact evidence." };
    await execute(task);
    const dispatched = latestReceipt();
    // Dispatch receipts are not completion: wait for the actual manager/SDK run.
    assert.deepEqual(dispatched.route, route);
    await manager.waitForAll();
    await execute({ action: "status", handle: dispatched.handle });
    const first = latestReceipt();
    const firstRecord = manager.getRecord(first.agentId)!;
    assert.equal(first.status, "completed", firstRecord.error);
    assert.equal(firstRecord.result, "Synthetic source-impact evidence 1");
    assert.ok(first.sessionId);
    assert.ok(firstRecord.session);
    assert.equal(firstRecord.session.model?.id, workerModel.id);
    assert.equal(firstRecord.session.model?.provider, "xai");
    assert.equal(firstRecord.session.thinkingLevel, "low");
    // maxTurns is a runner policy, not a native provider stream option.
    assert.equal(spawnRequests.length, 1);
    assert.equal(spawnRequests[0].maxTurns, 12);
    assert.equal(spawnRequests[0].thinkingLevel, "low");
    assert.deepEqual(spawnRequests[0].route, route);
    assert.deepEqual(firstRecord.session.getActiveToolNames().sort(), ["find", "grep", "ls", "read"]);
    const sdkSession = firstRecord.session;
    await execute({ ...task, task: "Continue the same bounded source-impact task with one additional caller." });
    await manager.waitForAll();
    await execute({ action: "status", handle: first.handle });
    const second = latestReceipt();
    assert.equal(second.handle, first.handle);
    assert.equal(second.agentId, first.agentId);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.status, "completed");
    assert.equal(manager.getRecord(second.agentId)!.session, sdkSession);
    assert.equal(manager.getRecord(second.agentId)!.result, "Synthetic source-impact evidence 2");
    const routes = entries.filter(entry => entry.name === "jev-worker-route").map(entry => entry.data as { resumed: boolean; taskFamily: string; route: unknown });
    assert.deepEqual(routes.map(entry => entry.resumed), [false, true]);
    assert.ok(routes.every(entry => entry.taskFamily === family));
    assert.equal(calls.length, 2);

    policy = { mode: "allowlist", routes: [routeKey] };
    available = [parentModel];
    await assert.rejects(execute({ ...task, taskKey: "unavailable-strict" }), /No eligible quality-qualified worker route; no fallback/);
    assert.equal(calls.length, 2, "Unavailable strict allowlist must refuse before any provider call");
    available = [parentModel, workerModel];
    family = "uncovered";
    await assert.rejects(execute({ ...task, taskKey: "uncovered-strict" }), /No eligible quality-qualified worker route; no fallback/);
    assert.equal(calls.length, 2, "Scout evidence must not qualify an uncovered task");
    family = "source-impact-location";
    qualifications = [];
    // Even with the Codex baseline available, explicit resume cannot switch route
    // or reuse xai after its qualification is revoked.
    policy = { mode: "prefer-other-provider" };
    await assert.rejects(execute({ action: "resume", handle: first.handle, task: "Must not resume after revocation" }), /Existing worker is no longer suitable/);
    assert.equal(calls.length, 2);
    assert.equal(entries.filter(entry => entry.name === "jev-worker-route").length, 2);
    assert.equal(evaluations, 5);
    assert.equal(spawnRequests.length, 1, "Resume and refusals must not create another worker");
    assert.equal(ctx.model, parentModel);
    assert.deepEqual({ provider: ctx.model!.provider, model: ctx.model!.id }, baseline);
    assert.equal(pi.getThinkingLevel(), "low");
    assert.equal(setModelCalls, 0);
    assert.equal(setThinkingCalls, 0);
    assert.equal([...listeners.keys()].filter(channel => channel.includes(":reply:")).length, 0);
  } finally {
    try {
      await lifecycle.get("session_shutdown")?.({}, ctx);
      workers.dispose();
      rpc.unsubPing(); rpc.unsubSpawn(); rpc.unsubStop(); rpc.unsubConsume(); rpc.unsubWorkers();
      await manager.dispose();
    } finally {
      ModelRuntime.create = originalCreate;
    }
  }
});
