import { describe, expect, it } from "vitest";
import { observeAllowance } from "../src/managed-allowance.js";

const NOW = 1_750_000_000_000;
const RESET = NOW / 1000 + 300;
function complete(family = "codex", window = "primary", percent = "42"): Record<string, string> {
  return {
    [`x-${family}-${window}-used-percent`]: percent,
    [`x-${family}-${window}-window-minutes`]: "300",
    [`x-${family}-${window}-reset-at`]: String(RESET),
  };
}
function observe(headers: Record<string, string>, observedAt = NOW) {
  return observeAllowance("openai-codex", "gpt-5", headers, observedAt);
}
function unsafe(value: unknown): Record<string, string> {
  return value as Record<string, string>;
}

describe("managed allowance snapshots", () => {
  it("returns only account-window snapshots, normalises case and converts reset seconds to milliseconds", () => {
    const headers = Object.fromEntries(Object.entries(complete()).map(([key, value]) => [key.toUpperCase(), value]));
    expect(observe(headers)).toEqual({
      scope: "account-window", provider: "openai-codex", model: "gpt-5", observedAt: NOW,
      source: "codex-response-headers", attribution: "unknown", invalid: false,
      windows: [{ family: "codex", window: "primary", usedPercent: 42, windowMinutes: 300, resetsAt: RESET * 1000 }],
    });
  });

  it("supports independent primary, secondary and bounded named families including genuine zero usage", () => {
    const result = observe({ ...complete("codex", "primary", "0"), ...complete("codex", "secondary", "100"), ...complete("codex-spark-v2", "primary", "12.5") });
    expect(result.invalid).toBe(false);
    expect(result.windows.map(({ family, window, usedPercent }) => ({ family, window, usedPercent }))).toEqual([
      { family: "codex", window: "primary", usedPercent: 0 },
      { family: "codex", window: "secondary", usedPercent: 100 },
      { family: "codex-spark-v2", window: "primary", usedPercent: 12.5 },
    ]);
  });

  it.each(["xai", "openai", "OpenAI-Codex", "openai-codex ", ""])("never parses headers for provider %s", provider => {
    expect(observeAllowance(provider, "model", complete(), NOW)).toMatchObject({ source: "unavailable", invalid: false, windows: [] });
  });

  it("does not even inspect xai headers", () => {
    const headers = new Proxy({}, { ownKeys() { throw new Error("must not inspect"); }, getPrototypeOf() { throw new Error("must not inspect"); } });
    expect(observeAllowance("xai", "grok", headers, NOW)).toMatchObject({ source: "unavailable", invalid: false, windows: [] });
  });

  it("reports absence without claiming zero usage", () => {
    expect(observe({})).toMatchObject({ source: "unavailable", invalid: false, windows: [] });
    expect(observe({ "x-ratelimit-remaining-tokens": "0", "x-ratelimit-limit-requests": "100" })).toMatchObject({ source: "unavailable", invalid: false, windows: [] });
  });

  it.each(["used-percent", "window-minutes", "reset-at"])("omits incomplete windows missing %s", field => {
    const headers = complete();
    delete headers[`x-codex-primary-${field}`];
    expect(observe(headers)).toMatchObject({ source: "codex-response-headers", invalid: true, windows: [] });
  });

  it.each(["-1", "100.01", "NaN", "Infinity", "-Infinity", "", " ", "\t", " 42", "42 ", "1e1", "0x10", "+1", "1,5", "2\n", "9".repeat(65)])("rejects malformed percentage %j without clamping", value => {
    expect(observe(complete("codex", "primary", value))).toMatchObject({ invalid: true, windows: [] });
  });

  it.each(["0", "-1", "1.5", "525601", "9007199254740992", "Infinity", "NaN", "", " ", "1e2"])("rejects malformed minutes %j", value => {
    expect(observe({ ...complete(), "x-codex-primary-window-minutes": value })).toMatchObject({ invalid: true, windows: [] });
  });

  it.each([String(RESET + 0.5), String(NOW / 1000 - 1), String(NOW / 1000 + 300 * 60 + 61), String(NOW), "-1", "0", "9007199254740992", "Infinity", "NaN", "", " ", "1e10"])("rejects stale, implausible or malformed reset %j", value => {
    expect(observe({ ...complete(), "x-codex-primary-reset-at": value })).toMatchObject({ invalid: true, windows: [] });
  });

  it("accepts exact reset bounds including the 60 second upper clock-skew allowance", () => {
    for (const seconds of [NOW / 1000, NOW / 1000 + 300 * 60 + 60]) {
      expect(observe({ ...complete(), "x-codex-primary-reset-at": String(seconds) }).invalid).toBe(false);
    }
    expect(observe({ ...complete(), "x-codex-primary-reset-at": String(NOW / 1000) }, NOW + 1).invalid).toBe(true);
    expect(observe({ ...complete(), "x-codex-primary-window-minutes": "525600" }).invalid).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER, undefined, null, "1750000000000", {}, 1n])("handles invalid observedAt %s with a safe zero timestamp", value => {
    expect(observeAllowance("openai-codex", "gpt-5", complete(), value as number)).toMatchObject({ observedAt: 0, source: "unavailable", invalid: true, windows: [] });
  });

  it("accepts an epoch-zero observation with a plausible reset", () => {
    expect(observe({ ...complete(), "x-codex-primary-reset-at": "300" }, 0).invalid).toBe(false);
  });

  it.each([undefined, null, 42, true, "headers", [], new Date(), new Map(), () => undefined])("is nonthrowing for malformed runtime header container %s", value => {
    expect(observe(unsafe(value))).toMatchObject({ source: "unavailable", invalid: true, windows: [] });
  });

  it.each([null, undefined, NaN, Infinity, -1, 0, {}, [], true, 1n, Symbol("secret")])("does not coerce malformed runtime scalars %s", value => {
    expect(observe(unsafe({ ...complete(), "x-codex-primary-used-percent": value }))).toMatchObject({ invalid: true, windows: [] });
  });

  it("does not coerce malformed provider/model identities", () => {
    const hostile = { toString() { throw new Error("secret"); } };
    expect(observeAllowance(hostile as unknown as string, "model", complete(), NOW)).toMatchObject({ provider: "", invalid: true, source: "unavailable" });
    expect(observeAllowance("openai-codex", hostile as unknown as string, complete(), NOW)).toMatchObject({ model: "", invalid: true, source: "unavailable" });
  });

  it("rejects conflicts only in the affected window, including conflicting casing", () => {
    const result = observe({ ...complete(), ...complete("codex", "secondary"), "X-CODEX-PRIMARY-USED-PERCENT": "43" });
    expect(result.invalid).toBe(true);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].window).toBe("secondary");
    expect(observe({ ...complete(), "X-CODEX-PRIMARY-USED-PERCENT": "42" }).invalid).toBe(false);
    expect(observe({ "X-CODEX-PRIMARY-USED-PERCENT": "43", ...complete() }).windows).toEqual([]);
  });

  it("retains an independently valid window alongside a partial window", () => {
    const result = observe({ ...complete(), "x-codex-secondary-used-percent": "0" });
    expect(result.invalid).toBe(true);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].window).toBe("primary");
  });

  it("caps scanning at 256 headers and discards an incomplete scan", () => {
    const headers = complete();
    for (let i = 0; i < 253; i++) headers[`ignored-${i}`] = "private";
    expect(observe(headers).invalid).toBe(false);
    Object.defineProperty(headers, "unscanned", { enumerable: true, get() { throw new Error("do not read"); } });
    expect(observe(headers)).toMatchObject({ source: "unavailable", invalid: true, windows: [] });
  });

  it("caps recognised families at eight", () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 8; i++) Object.assign(headers, complete(`codex-f${i}`));
    expect(observe(headers).windows).toHaveLength(8);
    Object.assign(headers, complete("codex-f8"));
    expect(observe(headers)).toMatchObject({ source: "unavailable", invalid: true, windows: [] });
  });

  it("bounds family suffixes, header names and scalar lengths", () => {
    expect(observe(complete(`codex-${"a".repeat(48)}`)).windows).toHaveLength(1);
    expect(observe(complete(`codex-${"a".repeat(49)}`))).toMatchObject({ source: "unavailable", invalid: false, windows: [] });
    expect(observe(complete(`codex-${"a".repeat(128)}`))).toMatchObject({ source: "unavailable", invalid: false, windows: [] });
    expect(observe(complete("codex", "primary", `${"0".repeat(63)}1`)).invalid).toBe(false);
    expect(observe(complete("codex", "primary", `${"0".repeat(64)}1`)).invalid).toBe(true);
  });

  it("does not leak unknown header names or any raw secret values", () => {
    const secret = "PRIVATE_SECRET_SENTINEL";
    const headers = {
      ...complete(), authorization: secret, "x-account-id": secret, "x-request-id": secret,
      "x-codex-credits-balance": secret, "x-codex-account-id": secret,
      "x-codex-primary-extra": secret, "x-codex--primary-used-percent": secret,
      "x-codex-evil/private-primary-used-percent": secret,
      "prefix-x-codex-primary-used-percent": secret,
      "x-codex-primary-used-percent-suffix": secret,
      "x-ratelimit-remaining-tokens": secret,
    };
    const result = observe(headers);
    expect(result.invalid).toBe(false);
    expect(result.windows).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toMatch(/authorization|account-id|request-id|credits|tokens|evil|extra/);
    expect(JSON.stringify(observe({ ...complete(), "x-codex-primary-used-percent": secret }))).not.toContain(secret);
  });

  it("does not invoke accessors, handles hostile proxies, and rejects custom prototypes", () => {
    let reads = 0;
    const headers = complete();
    Object.defineProperty(headers, "authorization", { enumerable: true, get() { reads++; throw new Error("private"); } });
    expect(observe(headers).invalid).toBe(false);
    Object.defineProperty(headers, "x-codex-primary-used-percent", { enumerable: true, get() { reads++; throw new Error("private"); } });
    expect(observe(headers)).toMatchObject({ invalid: true, windows: [] });
    expect(reads).toBe(0);
    expect(observe(new Proxy({}, { ownKeys() { throw new Error("private"); } }))).toMatchObject({ invalid: true, windows: [] });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(observe(revoked.proxy)).toMatchObject({ invalid: true, windows: [] });
    expect(observe(unsafe(Object.create(complete())))).toMatchObject({ invalid: true, windows: [] });
    const nullPrototype: Record<string, string> = Object.assign(Object.create(null), complete());
    expect(observe(nullPrototype).invalid).toBe(false);
  });

  it("does not mutate input or share returned window arrays", () => {
    const headers = Object.freeze(complete());
    const first = observe(headers);
    first.windows.length = 0;
    expect(observe(headers).windows).toHaveLength(1);
    expect(headers).toEqual(complete());
  });
});
