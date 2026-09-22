import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { type ExtensionAPI, type ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import { NativeWorkerCatalogue } from "../src/managed-worker-runtime.js";
import { ManagedWorkers } from "../src/managed-workers.js";

afterEach(() => vi.restoreAllMocks());

describe("public runtime catalogue", () => {
  it("uses one configuration-free runtime and preserves provider identity", async () => {
    const create = ModelRuntime.create.bind(ModelRuntime);
    const spy = vi.spyOn(ModelRuntime, "create").mockImplementation(options => create({ ...options, credentials: new InMemoryCredentialStore() }));
    const catalogue = new NativeWorkerCatalogue();
    const route = { provider: "openai-codex", model: "unused-catalogue-lookup" };
    const [first, second] = await Promise.all([catalogue.get(route), catalogue.get(route)]);
    expect(first).toBe(second);
    expect(first.auth.oauth?.isSubscription).toBe(true);
    expect(first.getModels().length).toBeGreaterThan(0);
    expect((await catalogue.get({ provider: "xai", model: "unused" })).auth.oauth?.isSubscription).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  });

  it("refuses unsupported providers before runtime construction", async () => {
    const spy = vi.spyOn(ModelRuntime, "create");
    const catalogue = new NativeWorkerCatalogue();
    await expect(catalogue.get({ provider: "anthropic", model: "anything" })).rejects.toThrow("billing-unverified");
    await expect(catalogue.get({ provider: "custom", model: "anything" })).rejects.toThrow("native");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not retry a failed catalogue initialisation implicitly", async () => {
    const spy = vi.spyOn(ModelRuntime, "create").mockRejectedValue(new Error("catalogue unavailable"));
    const catalogue = new NativeWorkerCatalogue();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(catalogue.get({ provider: "xai", model: "anything" })).rejects.toThrow("catalogue unavailable");
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

for (const invalidation of ["dispose", "abort", "owner"] as const) {
  it(`cannot spawn after ${invalidation} during catalogue acquisition`, async () => {
    registerAgents([]);
    let owner = "original";
    let release!: (provider: Provider) => void;
    const pending = new Promise<Provider>(resolve => { release = resolve; });
    const spawn = vi.fn();
    const manager = { spawn } as unknown as AgentManager;
    const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => owner } } as unknown as ExtensionContext;
    const workers = new ManagedWorkers({} as ExtensionAPI, manager, () => ctx, () => pending);
    const signal = new AbortController();
    const result = workers.spawn({ requestId: "race", type: "general-purpose", prompt: "Inspect", route: { provider: "openai-codex", model: "unused" }, cwd: process.cwd(), access: "read-only", signal: signal.signal });
    if (invalidation === "dispose") workers.dispose();
    if (invalidation === "abort") signal.abort();
    if (invalidation === "owner") owner = "replacement";
    release(openaiCodexProvider());
    await expect(result).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
}
