import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Provider } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { WorkerClient, type WorkerBus } from "../../pi-jev-assist/src/worker-client.js";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import { registerRpcHandlers } from "../src/cross-extension-rpc.js";
import { ManagedWorkers } from "../src/managed-workers.js";
import { fixtureRepository } from "./fixture-repository.js";

// Opt-in sibling-checkout integration: bun test integration/jev-worker-contract.test.ts.
// Actual client, RPC, manager and SDK sessions; only provider responses are simulated.
// No account credentials are loaded and no requests leave this process.
test("Jev client crosses the runner RPC into a real reusable SDK session", async () => {
  const credentials = new InMemoryCredentialStore();
  const originalCreate = ModelRuntime.create.bind(ModelRuntime);
  const catalogue = await originalCreate({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const native = catalogue.getProvider("openai-codex")!;
  const model = native.getModels()[0];
  const route = { provider: model.provider, model: model.id };
  await credentials.modify(model.provider, async () => ({ type: "oauth", access: "synthetic", refresh: "synthetic", expires: Date.now() + 86_400_000 }));
  let calls = 0;
  let writing = false;
  let writeTurn = 0;
  const stream: Provider["streamSimple"] = (actual) => {
    calls++;
    const events = new AssistantMessageEventStream();
    const edit = writing && writeTurn++ === 0;
    const message: AssistantMessage = {
      role: "assistant", provider: actual.provider, model: actual.id, api: actual.api,
      content: edit ? [{ type: "toolCall", id: "synthetic-write", name: "write", arguments: { path: "value.ts", content: "export const value = 2;\n" } }] : [{ type: "text", text: `Synthetic answer ${calls}` }], stopReason: edit ? "toolUse" : "stop", timestamp: Date.now(),
      usage: { input: 8, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(() => { events.push({ type: "done", reason: edit ? "toolUse" : "stop", message }); events.end(message); });
    return events;
  };
  const provider: Provider = { ...native, auth: { oauth: { ...native.auth.oauth!, toAuth: async () => ({ apiKey: "synthetic" }) } }, stream, streamSimple: stream };
  ModelRuntime.create = options => originalCreate({ ...options, credentials });
  registerAgents([]);
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const bus: WorkerBus = {
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener); listeners.set(channel, set);
      return () => { set.delete(listener); if (!set.size) listeners.delete(channel); };
    },
    emit(channel, data) { for (const listener of [...(listeners.get(channel) ?? [])]) listener(data); },
  };
  let oauth = true;
  const ctx = {
    cwd: process.cwd(), model: { ...model, id: "untouched-parent" },
    sessionManager: { getSessionId: () => "parent-session" }, getSystemPrompt: () => "Inspect the specified task only.",
    modelRegistry: {
      find: () => model, getAvailable: () => [model], isUsingOAuth: () => oauth,
      getProvider: () => provider, getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined,
    },
  } as unknown as ExtensionContext;
  const entries: unknown[] = [];
  const fixture = fixtureRepository();
  const pi = { exec: fixture.exec, appendEntry: (_name: string, data: unknown) => entries.push(data) } as unknown as ExtensionAPI;
  const manager = new AgentManager();
  const workers = new ManagedWorkers(pi, manager, () => ctx, async () => provider);
  const rpc = registerRpcHandlers({ events: bus, pi, getCtx: () => ctx, managedWorkers: workers, manager: {
    spawn: () => { throw new Error("Legacy spawn is forbidden in this test"); }, awaitStartup: async () => {},
    abort: id => manager.abort(id), getRecord: id => manager.getRecord(id), consumeResult: () => false,
  } });
  const client = new WorkerClient(bus);
  try {
    await client.available();
    const started = await client.spawn({ type: "general-purpose", prompt: "Inspect a synthetic task", route, cwd: process.cwd(), access: "read-only", thinkingLevel: "low", maxTurns: 1 });
    await manager.waitForAll();
    const first = await client.status(started.handle);
    assert.equal(first.status, "completed");
    assert.equal(first.result, "Synthetic answer 1");
    assert.deepEqual(first.route, route);
    assert.ok(first.sessionId);
    assert.deepEqual(manager.getRecord(first.agentId)!.session!.getActiveToolNames().sort(), ["find", "grep", "ls", "read"]);
    await client.resume(first.handle, "Continue that same task", route);
    await manager.waitForAll();
    const second = await client.status(first.handle);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.result, "Synthetic answer 2");
    assert.deepEqual(second.usage, { input: 16, output: 6, cacheRead: 4, cacheWrite: 0 });
    assert.equal(manager.getRecord(first.agentId)!.lifetimeUsage.input, 16);
    assert.equal(ctx.model!.id, "untouched-parent");
    oauth = false;
    await assert.rejects(client.resume(first.handle, "Must not run", route), /subscription OAuth/);
    await client.stop(first.handle);
    assert.equal(calls, 2);
    workers.dispose();
    await assert.rejects(client.status(first.handle), /stale/);
    assert.ok(entries.length > 0);

    oauth = true;
    ctx.cwd = fixture.parent;
    writing = true;
    const input = { type: "general-purpose", prompt: "Change value.ts in this checkout to export value 2", route, access: "write" as const, thinkingLevel: "low", maxTurns: 3 };
    await assert.rejects(client.spawn({ ...input, cwd: fixture.parent }), /separate registered linked/);
    await assert.rejects(client.spawn({ ...input, cwd: fixture.unrelated }), /separate registered linked/);
    assert.equal(calls, 2);
    const writer = await client.spawn({ ...input, cwd: fixture.linked });
    await manager.waitForAll();
    const written = await client.status(writer.handle);
    assert.equal(written.status, "completed", written.error);
    assert.equal(readFileSync(join(fixture.linked, "value.ts"), "utf8"), "export const value = 2;\n");
    assert.equal(readFileSync(join(fixture.parent, "value.ts"), "utf8"), "export const value = 1;\n");
    assert.equal(calls, 4);
    assert.equal(ctx.model!.id, "untouched-parent");
    assert.equal([...listeners.keys()].filter(channel => channel.includes(":reply:")).length, 0);
  } finally {
    client.dispose(); workers.dispose();
    rpc.unsubPing(); rpc.unsubSpawn(); rpc.unsubStop(); rpc.unsubConsume(); rpc.unsubWorkers();
    await manager.dispose();
    ModelRuntime.create = originalCreate;
    fixture.dispose();
  }
});
