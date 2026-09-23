import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Provider } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import { canonicalDirectory } from "../src/managed-worker-runtime.js";
import { ManagedWorkerStore, type WorkerOwner } from "../src/managed-worker-store.js";
import { ManagedWorkers } from "../src/managed-workers.js";
import { fixtureRepository } from "./fixture-repository.js";

for (const thinkingLevel of ["low", "off"] as const) {
test(`cold runner restores only its persistent owner's exact session without prompt replay (${thinkingLevel})`, async () => {
  const fixture = fixtureRepository();
  const credentials = new InMemoryCredentialStore();
  const originalCreate = ModelRuntime.create.bind(ModelRuntime);
  const catalogue = await originalCreate({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const native = catalogue.getProvider("openai-codex")!;
  const model = native.getModels()[0];
  await credentials.modify(model.provider, async () => ({ type: "oauth", access: "test", refresh: "test", expires: Date.now() + 86_400_000 }));
  let calls = 0;
  let historySeen = false;
  const answer = (): AssistantMessage => ({ role: "assistant", provider: model.provider, model: model.id, api: model.api, content: [{ type: "text", text: "Source-linked synthetic answer" }], stopReason: "stop", timestamp: Date.now(), usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const stream: Provider["streamSimple"] = (_model, context) => {
    calls++;
    if (calls === 2) historySeen = context.messages.some(message => message.role === "assistant");
    const events = new AssistantMessageEventStream();
    const message = answer();
    queueMicrotask(() => { events.push({ type: "done", reason: "stop", message }); events.end(message); });
    return events;
  };
  const provider: Provider = { ...native, auth: { oauth: { ...native.auth.oauth!, toAuth: async () => ({ apiKey: "test" }) } }, stream, streamSimple: stream };
  ModelRuntime.create = options => originalCreate({ ...options, credentials });
  const parent = SessionManager.create(fixture.parent, join(fixture.root, "parent-sessions"));
  parent.appendMessage(answer());
  const parentFile = parent.getSessionFile()!;
  const context = (sessionManager: SessionManager) => ({ cwd: canonicalDirectory(fixture.parent), model, sessionManager,
    getSystemPrompt: () => "Synthetic recovery task. Preserve the prior evidence.",
    modelRegistry: { find: () => model, getAvailable: () => [model], isUsingOAuth: () => true, getProvider: () => provider, getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined },
  } as unknown as ExtensionContext);
  const pi = { exec: fixture.exec, appendEntry: () => {} } as unknown as ExtensionAPI;
  const store = new ManagedWorkerStore(join(fixture.root, "managed-store"));
  registerAgents([]);
  const firstManager = new AgentManager();
  const secondManager = new AgentManager();
  const first = new ManagedWorkers(pi, firstManager, () => context(parent), async () => provider, store);
  const reopenedParent = () => SessionManager.open(parentFile);
  const second = new ManagedWorkers(pi, secondManager, () => context(reopenedParent()), async () => provider, new ManagedWorkerStore(join(fixture.root, "managed-store")));
  try {
    const receipt = await first.spawn({ requestId: "one", type: "general-purpose", prompt: "First investigation", route: { provider: model.provider, model: model.id }, cwd: canonicalDirectory(fixture.parent), access: "read-only", thinkingLevel, maxTurns: 3 });
    await firstManager.waitForAll();
    const initial = first.status({ requestId: "s1", handle: receipt.handle });
    assert.equal(initial.status, "completed");
    assert.ok(initial.sessionId);
    const owner: WorkerOwner = { id: parent.getSessionId(), parentFile, workspace: canonicalDirectory(fixture.parent) };
    const beforeLease = store.load(owner, receipt.handle);
    assert.equal(beforeLease.thinking, thinkingLevel === "off" ? undefined : thinkingLevel);
    if (thinkingLevel === "off") {
      assert.equal(Object.hasOwn(beforeLease, "thinking"), false, "off must be omitted from the persisted manifest");
      assert.equal(firstManager.getRecord(receipt.agentId)?.session?.thinkingLevel, "off");
    }
    const release = store.acquireSession(beforeLease);
    try {
      assert.equal(second.status({ requestId: "retained-lease", handle: receipt.handle }).status, "interrupted");
      assert.equal(calls, 1, "cold status with a retained lease must not call the provider");
      await first.resume({ requestId: "contended", handle: receipt.handle, prompt: "Must not run" });
      await firstManager.waitForAll();
      assert.match(first.status({ requestId: "blocked", handle: receipt.handle }).error ?? "", /leased/);
      assert.deepEqual(store.load(owner, receipt.handle), beforeLease, "a rejected lease must not overwrite the manifest");
      assert.equal(calls, 1);
    } finally { release(); }
    const coldStatus = second.status({ requestId: "saved", handle: receipt.handle });
    assert.equal(coldStatus.status, "completed");
    assert.equal(coldStatus.error, undefined, "a completed persisted session must not masquerade as a provider failure");
    assert.equal(calls, 1, "status must not replay a prompt");
    await second.resume({ requestId: "two", handle: receipt.handle, prompt: "Follow up using your saved evidence" });
    await secondManager.waitForAll();
    const resumed = second.status({ requestId: "s2", handle: receipt.handle });
    assert.equal(resumed.status, "completed", resumed.error);
    assert.equal(resumed.sessionId, initial.sessionId);
    if (thinkingLevel === "off") {
      assert.equal(secondManager.getRecord(resumed.agentId)?.session?.thinkingLevel, "off");
      assert.equal(Object.hasOwn(store.load(owner, receipt.handle), "thinking"), false);
    }
    assert.equal(calls, 2);
    assert.equal(historySeen, true);

    const afterSecond = store.load(owner, receipt.handle);
    await first.resume({ requestId: "stale", handle: receipt.handle, prompt: "Must not branch from old history" });
    await firstManager.waitForAll();
    assert.match(first.status({ requestId: "stale-status", handle: receipt.handle }).error ?? "", /Stale (?:live worker transcript|worker manifest)/);
    assert.equal(calls, 2, "stale history must never reach the provider");
    assert.deepEqual(store.load(owner, receipt.handle), afterSecond);
    const manifest = store.load(owner, receipt.handle);
    assert.equal(manifest.state, "completed");
    const foreign = { ...owner, id: randomUUID() };
    assert.throws(() => store.load(foreign, receipt.handle), /foreign/);
    assert.throws(() => store.load(owner, "../manifest.json"), /stale/);
    const folder = store.sessionDirectory(owner, receipt.handle);
    const originalManifest = readFileSync(join(folder, "manifest.json"), "utf8");
    writeFileSync(join(folder, "manifest.json"), '{"version":');
    assert.throws(() => store.load(owner, receipt.handle), /Corrupt/);
    writeFileSync(join(folder, "manifest.json"), originalManifest);
    store.save({ ...manifest, state: "running" });
    const third = new ManagedWorkers(pi, new AgentManager(), () => context(reopenedParent()), async () => provider, store);
    await assert.rejects(third.resume({ requestId: "interrupted", handle: receipt.handle, prompt: "Do not replay" }), /interrupted/);
    assert.equal(calls, 2);
  } finally {
    first.dispose(); second.dispose();
    await firstManager.dispose(); await secondManager.dispose();
    ModelRuntime.create = originalCreate;
    fixture.dispose();
  }
});
}

test("independent stores exclude competing writers and never steal interrupted leases", () => {
  const fixture = fixtureRepository();
  try {
    const a = new ManagedWorkerStore(join(fixture.root, "store"));
    const b = new ManagedWorkerStore(join(fixture.root, "store"));
    const release = a.acquireWriter(fixture.linked, randomUUID());
    assert.throws(() => b.acquireWriter(fixture.linked, randomUUID()), /leased/);
    release();
    const releaseSecond = b.acquireWriter(fixture.linked, randomUUID());
    releaseSecond();
  } finally { fixture.dispose(); }
});
