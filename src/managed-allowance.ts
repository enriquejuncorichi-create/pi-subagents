export interface AllowanceObservation {
  scope: "account-window";
  provider: string;
  model: string;
  /** Epoch milliseconds, as with Date.now(). */
  observedAt: number;
  source: "codex-response-headers" | "unavailable";
  windows: Array<{
    /** Header namespace: codex, codex-spark, etc. */
    family: string;
    window: "primary" | "secondary";
    usedPercent: number;
    windowMinutes: number;
    /** Epoch milliseconds; the response header uses epoch seconds. */
    resetsAt: number;
  }>;
  invalid: boolean;
  attribution: "unknown";
}

type WindowName = "primary" | "secondary";
type Field = "used-percent" | "window-minutes" | "reset-at";
interface Candidate {
  family: string;
  window: WindowName;
  fields: Partial<Record<Field, string>>;
  invalid: boolean;
}

// Best-effort, unstable account snapshots, never a per-request debit.
// Header semantics pinned to the official implementation:
// https://github.com/openai/codex/blob/eaf81d3f/codex-rs/codex-api/src/rate_limits.rs
const HEADER = /^x-(codex(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?)-(primary|secondary)-(used-percent|window-minutes|reset-at)$/;
const DECIMAL = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const INTEGER = /^\d+$/;
const MAX_HEADERS = 256;
const MAX_FAMILIES = 8;
const MAX_NAME = 128;
const MAX_SCALAR = 64;
const MAX_FAMILY_SUFFIX = 48;
const MAX_WINDOW_MINUTES = 525_600;
const CLOCK_SKEW_MS = 60_000;

export function observeAllowance(
  provider: string,
  model: string,
  headers: Record<string, string>,
  observedAt: number,
): AllowanceObservation {
  const validTime = typeof observedAt === "number" && Number.isSafeInteger(observedAt)
    && observedAt >= 0 && observedAt <= 8_640_000_000_000_000;
  const result: AllowanceObservation = {
    scope: "account-window",
    provider: typeof provider === "string" ? provider : "",
    model: typeof model === "string" ? model : "",
    observedAt: validTime ? observedAt : 0,
    source: "unavailable",
    windows: [],
    invalid: !validTime || typeof provider !== "string" || typeof model !== "string",
    attribution: "unknown",
  };
  if (result.invalid || provider !== "openai-codex") return result;

  // Discard all candidates on structural errors or caps: an unseen duplicate
  // could otherwise contradict a seemingly valid window earlier in the record.
  const reject = (): AllowanceObservation => ({ ...result, source: "unavailable", windows: [], invalid: true });
  try {
    if (headers === null || typeof headers !== "object" || Array.isArray(headers)) return reject();
    const prototype: unknown = Object.getPrototypeOf(headers);
    if (prototype !== null && prototype !== Object.prototype) return reject();
    const candidates = new Map<string, Candidate>();
    const families = new Set<string>();
    let scanned = 0;
    for (const name in headers) {
      if (!Object.hasOwn(headers, name)) continue;
      if (++scanned > MAX_HEADERS) return reject();
      if (name.length > MAX_NAME) continue;
      const match = HEADER.exec(name.toLowerCase());
      if (!match) continue;
      const family = match[1];
      if (family.length > "codex-".length + MAX_FAMILY_SUFFIX) continue;
      families.add(family);
      if (families.size > MAX_FAMILIES) return reject();
      const window = match[2] as WindowName;
      const field = match[3] as Field;
      const key = `${family}/${window}`;
      let candidate = candidates.get(key);
      if (!candidate) {
        candidate = { family, window, fields: {}, invalid: false };
        candidates.set(key, candidate);
      }
      // Do not invoke getters or coerce unknown runtime values into strings.
      const descriptor = Object.getOwnPropertyDescriptor(headers, name);
      const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (typeof value !== "string" || value.length > MAX_SCALAR) {
        candidate.invalid = true;
        continue;
      }
      if (candidate.fields[field] !== undefined && candidate.fields[field] !== value) {
        candidate.invalid = true;
      }
      candidate.fields[field] = value;
    }
    if (candidates.size === 0) return result;
    result.source = "codex-response-headers";
    for (const candidate of candidates.values()) {
      const percent = candidate.fields["used-percent"];
      const minutes = candidate.fields["window-minutes"];
      const reset = candidate.fields["reset-at"];
      if (candidate.invalid || percent === undefined || minutes === undefined || reset === undefined
        || !DECIMAL.test(percent) || !INTEGER.test(minutes) || !INTEGER.test(reset)) {
        result.invalid = true;
        continue;
      }
      const usedPercent = Number(percent);
      const windowMinutes = Number(minutes);
      const resetSeconds = Number(reset);
      const resetsAt = resetSeconds * 1000;
      if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100
        || !Number.isSafeInteger(windowMinutes) || windowMinutes <= 0 || windowMinutes > MAX_WINDOW_MINUTES
        || !Number.isSafeInteger(resetSeconds) || !Number.isSafeInteger(resetsAt)
        || resetsAt < observedAt || resetsAt - observedAt > windowMinutes * 60_000 + CLOCK_SKEW_MS) {
        result.invalid = true;
        continue;
      }
      result.windows.push({ family: candidate.family, window: candidate.window, usedPercent, windowMinutes, resetsAt });
    }
    return result;
  } catch {
    // Proxies and hostile property descriptors must not break response handling.
    return reject();
  }
}
