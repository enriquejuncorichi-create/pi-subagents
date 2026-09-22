import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { validateWorkerRoute } from "../src/managed-worker-runtime.js";

// Native catalogue construction only: no runtime, credential store, refresh or inference.
function harness() {
  const native = xaiProvider();
  const canonical = native.getModels()[0];
  if (!canonical) throw new Error("Native xai catalogue is empty");
  const route = { provider: canonical.provider, model: canonical.id };
  const cached = { ...canonical, cost: { ...canonical.cost, tiers: [] } };
  const state: {
    model: Model<Api>;
    effective: Provider;
    oauth: boolean;
    available: boolean;
    registeredConfig: boolean;
    registeredNative: boolean;
  } = { model: cached, effective: native, oauth: true, available: true, registeredConfig: false, registeredNative: false };
  const registry = {
    find: () => state.model,
    getAvailable: () => state.available ? [state.model] : [],
    getProvider: () => state.effective,
    isUsingOAuth: () => state.oauth,
    getRegisteredProviderConfig: () => state.registeredConfig ? { baseUrl: native.baseUrl } : undefined,
    getRegisteredNativeProvider: () => state.registeredNative ? native : undefined,
  } satisfies Pick<ExtensionContext["modelRegistry"], "find" | "getAvailable" | "getProvider" | "isUsingOAuth" | "getRegisteredProviderConfig" | "getRegisteredNativeProvider">;
  const ctx = { modelRegistry: registry } as unknown as ExtensionContext;
  return { native, canonical, cached, state, validate: (provider: Provider = native) => validateWorkerRoute(ctx, route, provider) };
}

describe("managed xai catalogue provenance", () => {
  it("accepts cost.tiers-only cache drift and returns the clean native identity without mutation", () => {
    const h = harness();
    const before = structuredClone(h.cached);
    const nativeBefore = structuredClone(h.canonical);
    expect(h.cached).not.toEqual(h.canonical);
    expect(h.validate()).toBe(h.canonical);
    expect(h.validate()).not.toBe(h.cached);
    expect(h.cached).toEqual(before);
    expect(h.canonical).toEqual(nativeBefore);
  });

  it.each(["input", "output", "cacheRead", "cacheWrite"] as const)("rejects changed top-level cost.%s despite tier drift", field => {
    const h = harness();
    h.state.model = { ...h.cached, cost: { ...h.cached.cost, [field]: h.canonical.cost[field] + 1 } };
    expect(() => h.validate()).toThrow("provenance");
  });

  it("rejects unknown cost metadata rather than stripping all costs", () => {
    const h = harness();
    const cost = { ...h.cached.cost, unknownBillingOverride: true };
    h.state.model = { ...h.cached, cost };
    expect(() => h.validate()).toThrow("provenance");
  });

  const modelDrifts: ReadonlyArray<readonly [string, (model: Model<Api>) => Model<Api>]> = [
    ["id", model => ({ ...model, id: `${model.id}-tampered` })],
    ["provider", model => ({ ...model, provider: "tampered" })],
    ["API", model => ({ ...model, api: "anthropic-messages" })],
    ["baseURL", model => ({ ...model, baseUrl: "https://invalid.example" })],
    ["headers", model => ({ ...model, headers: { ...model.headers, "x-tampered": "true" } })],
    ["context", model => ({ ...model, contextWindow: model.contextWindow + 1 })],
    ["maxTokens", model => ({ ...model, maxTokens: model.maxTokens + 1 })],
    ["reasoning", model => ({ ...model, reasoning: !model.reasoning })],
    ["input", model => ({ ...model, input: [] })],
    ["capabilities", model => ({ ...model, capabilities: { unknownCapability: true } })],
    ["unknown model field", model => ({ ...model, unknownRouteOverride: true })],
  ];
  it.each(modelDrifts)("rejects %s drift despite tier metadata", (_label, drift) => {
    const h = harness();
    h.state.model = drift(h.cached);
    expect(() => h.validate()).toThrow(/provenance|unavailable/);
  });

  it.each(["registeredConfig", "registeredNative"] as const)("rejects %s even for the identical native provider", field => {
    const h = harness();
    h.state[field] = true;
    expect(() => h.validate()).toThrow("provenance");
  });

  it.each(["endpoint", "headers"] as const)("rejects effective provider %s overrides", field => {
    const h = harness();
    h.state.effective = field === "endpoint"
      ? { ...h.native, baseUrl: "https://invalid.example" }
      : { ...h.native, headers: { ...h.native.headers, "x-tampered": "true" } };
    expect(() => h.validate()).toThrow("provenance");
  });

  it("rejects unavailable routes", () => {
    const h = harness();
    h.state.available = false;
    expect(() => h.validate()).toThrow("unavailable");
  });

  it("rejects non-OAuth auth despite matching native metadata", () => {
    const h = harness();
    h.state.oauth = false;
    expect(() => h.validate()).toThrow("subscription OAuth");
  });

  it.each(["effective", "native"] as const)("rejects %s subscription tampering or missing OAuth", target => {
    for (const missing of [false, true]) {
      const h = harness();
      const oauth = h.native.auth.oauth;
      if (!oauth) throw new Error("Native xai OAuth is missing");
      const tampered: Provider = { ...h.native, auth: { ...h.native.auth, oauth: missing ? undefined : { ...oauth, isSubscription: false } } };
      if (target === "effective") h.state.effective = tampered;
      expect(() => h.validate(target === "native" ? tampered : h.native)).toThrow("subscription OAuth");
    }
  });
});
