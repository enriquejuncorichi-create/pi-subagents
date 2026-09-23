import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Api, Model, Provider, ProviderResponse } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, type ExtensionContext, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { RunOptions, RunResult } from "./agent-runner.js";
import { getAgentConfig } from "./agent-types.js";
import { runInChildSessionContext } from "./child-context.js";
import { type AllowanceObservation, observeAllowance } from "./managed-allowance.js";
import { type StoredWorker, workerHash } from "./managed-worker-store.js";

export interface WorkerRoute { provider: string; model: string }
export interface ManagedRun {
  route: WorkerRoute;
  native: Provider;
  access: "read-only" | "write";
  cwd: string;
  maxTurns: number;
  signal?: AbortSignal;
  busy?: boolean;
  /** Trusted host hook: reserve a bounded output allocation before each native request. */
  reserveRequest?(): number;
  onAllowance?(observation: AllowanceObservation): void;
  assertOwner(): ExtensionContext;
  onSession(session: AgentSession): void;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  sessionDirectory?: string;
  resumeSessionFile?: string;
  expectedSessionId?: string;
  expectedSystemHash?: string;
  acquireWriter?(root: string): () => void;
  acquireSession?(): () => void;
  onState?(state: StoredWorker["state"]): void;
}

const managedSessions = new WeakMap<AgentSession, ManagedRun>();

export function isManagedWorkerSession(session: AgentSession | undefined): boolean {
  return session !== undefined && managedSessions.has(session);
}

export function setManagedWorkerSignal(session: AgentSession, signal?: AbortSignal): void {
  const managed = managedSessions.get(session);
  if (managed) managed.signal = signal;
}

export function canonicalDirectory(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || !statSync(path).isDirectory()) throw new Error("Worker cwd must be an existing absolute directory");
  return realpathSync.native(path);
}

/** Verify an externally managed linked worktree; never create, commit or remove it. */
export async function verifyWorkerWorkspace(pi: ExtensionAPI, parentCwd: string, cwd: string, access: ManagedRun["access"]): Promise<string | undefined> {
  canonicalDirectory(cwd);
  if (access === "read-only") return;
  const git = async (dir: string, ...args: string[]) => {
    const result = await pi.exec("git", ["-C", dir, ...args], { timeout: 10_000 });
    if (result.code !== 0 || result.killed) throw new Error("Cannot verify external worker worktree");
    return result.stdout.trim();
  };
  const root = canonicalDirectory(await git(cwd, "rev-parse", "--show-toplevel"));
  const parent = canonicalDirectory(await git(parentCwd, "rev-parse", "--show-toplevel"));
  const common = canonicalDirectory(await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const parentCommon = canonicalDirectory(await git(parentCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const gitDir = canonicalDirectory(await git(cwd, "rev-parse", "--absolute-git-dir"));
  const listed = (await git(parentCwd, "worktree", "list", "--porcelain", "-z")).split("\0").filter(line => line.startsWith("worktree ")).map(line => canonicalDirectory(line.slice(9)));
  if (root === parent || common !== parentCommon || gitDir === common || !listed.includes(root)) throw new Error("Write worker requires a separate registered linked git worktree of the parent repository");
  // Resolve again after Git's awaits, rejecting a replaced cwd rather than following it.
  const subpath = relative(root, cwd);
  if (canonicalDirectory(cwd) !== cwd || subpath === ".." || subpath.startsWith(`..${sep}`) || isAbsolute(subpath)) throw new Error("Worker workspace changed during validation");
  return root;
}

function assertSupportedProvider(route: WorkerRoute): void {
  if (route.provider === "anthropic") throw new Error("Anthropic subscription billing-unverified: OAuth child paths may charge extra usage");
  if (!["openai-codex", "xai"].includes(route.provider)) throw new Error("Managed workers allow only native openai-codex and xai subscription routes");
}

/** Private, configuration-free catalogue; never inherit parent provider overrides.
 * Pi's extension loader aliases the pi-ai root to compat, so provider subpath
 * imports are unsafe here. Public runtime composition avoids that loader seam.
 */
export class NativeWorkerCatalogue {
  private runtime?: Promise<ModelRuntime>;
  async get(route: WorkerRoute): Promise<Provider> {
    assertSupportedProvider(route);
    this.runtime ??= ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const runtime = await this.runtime;
    const provider = runtime.getProvider(route.provider);
    if (!provider || runtime.getRegisteredProviderConfig(route.provider) || runtime.getRegisteredNativeProvider(route.provider)) throw new Error("Clean worker provider unavailable");
    return provider;
  }
}

/** Ignore only cached tier reporting metadata, preserving every other own field and prototype. */
function withoutCostTiers(model: Model<Api>): Model<Api> {
  const costDescriptors = Object.getOwnPropertyDescriptors(model.cost);
  delete costDescriptors.tiers;
  const cost = Object.create(Object.getPrototypeOf(model.cost), costDescriptors) as Model<Api>["cost"];
  const modelDescriptors = Object.getOwnPropertyDescriptors(model);
  modelDescriptors.cost = { ...modelDescriptors.cost, value: cost };
  // Tiers confer neither billing nor routing authority: subscription/auth and
  // endpoint guards remain mandatory, and only the clean native model is executed.
  return Object.create(Object.getPrototypeOf(model), modelDescriptors) as Model<Api>;
}

export function validateWorkerRoute(ctx: ExtensionContext, route: WorkerRoute, native: Provider): Model<Api> {
  assertSupportedProvider(route);
  const registry = ctx.modelRegistry;
  const model = registry.find(route.provider, route.model);
  const canonical = native.getModels().find(item => item.id === route.model && item.provider === route.provider);
  if (!model || !canonical || !registry.getAvailable().some(item => item.provider === route.provider && item.id === route.model)) throw new Error("Exact worker route is unavailable");
  const effective = registry.getProvider(route.provider);
  if (registry.getRegisteredProviderConfig(route.provider) || registry.getRegisteredNativeProvider(route.provider) || !isDeepStrictEqual(withoutCostTiers(model), withoutCostTiers(canonical)) || !effective || effective.baseUrl !== native.baseUrl || !isDeepStrictEqual(effective.headers, native.headers)) throw new Error("Worker provider/model overrides defeat native route provenance");
  if (!registry.isUsingOAuth(model) || registry.getProvider(route.provider)?.auth.oauth?.isSubscription !== true || native.auth.oauth?.isSubscription !== true) throw new Error("Worker route requires subscription OAuth; paid fallback is forbidden");
  return canonical;
}

/** An owned native runtime: API-key auth is absent, including at lazy request time. */
export async function createWorkerRuntime(managed: ManagedRun): Promise<{ runtime: ModelRuntime; model: Model<Api> }> {
  const native = managed.native;
  const model = validateWorkerRoute(managed.assertOwner(), managed.route, native);
  const check = (actual: Model<Api>) => {
    managed.signal?.throwIfAborted();
    validateWorkerRoute(managed.assertOwner(), managed.route, native);
    if (actual.provider !== model.provider || actual.id !== model.id || actual.api !== model.api) throw new Error("Worker effective route mismatch");
  };
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const responseObserver = (previous?: (response: ProviderResponse, actual: Model<Api>) => void | Promise<void>) =>
    async (response: ProviderResponse, actual: Model<Api>) => {
      // Observation must never cause a request, retry or request failure. Headers
      // are reduced before crossing the hook; no raw account/auth data is stored.
      try {
        managed.assertOwner();
        managed.onAllowance?.(observeAllowance(actual.provider, actual.id, response.headers, Date.now()));
      } catch { /* Missing or failed telemetry is not evidence of zero consumption. */ }
      await previous?.(response, actual);
    };
  // SDK 0.87 always supplies an onPayload bridge, even with no extensions.
  // Drop it at the native boundary instead of rejecting every SDK request;
  // managed workers deliberately permit no payload mutation hooks.
  // Removing apiKey structurally prevents a logout/credential replacement racing
  // preflight from resolving environment or stored API-key auth instead.
  runtime.registerNativeProvider({
    ...native,
    auth: { oauth: native.auth.oauth },
    stream: (actual, context, options) => {
      check(actual);
      options?.signal?.throwIfAborted();
      return native.stream(actual, context, { ...options, onPayload: undefined, onResponse: responseObserver(options?.onResponse), ...(managed.reserveRequest ? { maxTokens: managed.reserveRequest() } : {}), maxRetries: 0, ...(managed.route.provider === "openai-codex" ? { transport: "sse" as const } : {}) } as typeof options);
    },
    streamSimple: (actual, context, options) => {
      check(actual);
      options?.signal?.throwIfAborted();
      // Codex auto/WebSocket recovery is outside its maxRetries loop.
      // Pin SSE so a failed transport cannot silently issue another request.
      return native.streamSimple(actual, context, { ...options, onPayload: undefined, onResponse: responseObserver(options?.onResponse), ...(managed.reserveRequest ? { maxTokens: managed.reserveRequest() } : {}), maxRetries: 0, ...(managed.route.provider === "openai-codex" ? { transport: "sse" as const } : {}) });
    },
  });
  const stream = runtime.stream.bind(runtime);
  const streamSimple = runtime.streamSimple.bind(runtime);
  const guardOptions = (actual: Model<Api>, options: unknown) => {
    check(actual);
    if (!isDeepStrictEqual(actual, model)) throw new Error("Worker model configuration changed");
    const values = options as Record<string, unknown> | undefined;
    if (values && ["apiKey", "baseUrl", "env", "headers", "fetch"].some(key => values[key] !== undefined)) throw new Error("Worker request auth/config overrides are forbidden");
  };
  runtime.stream = (actual, context, options) => { guardOptions(actual, options); return stream(actual, context, options); };
  runtime.streamSimple = (actual, context, options) => { guardOptions(actual, options); return streamSimple(actual, context, options); };
  // SDK summaries use complete/completeSimple, which dispatch through these same
  // guarded stream methods. Provider retries are disabled at the native boundary.
  await runtime.refresh({ allowNetwork: false, providers: [managed.route.provider] });
  const available = await runtime.getAvailable(managed.route.provider);
  if (!available.some(item => item.id === model.id && item.provider === model.provider) || !runtime.isUsingOAuth(managed.route.provider)) throw new Error("Native subscription OAuth is unavailable");
  return { runtime, model };
}

function releaseLeases(releases: Array<(() => void) | undefined>, primary?: unknown): void {
  const failures: unknown[] = [];
  for (const release of releases) {
    try { release?.(); } catch (error) { failures.push(error); }
  }
  if (failures.length) {
    const errors = primary === undefined ? failures : [primary, ...failures];
    throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join("; "));
  }
}

export async function runManagedWorker(ctx: ExtensionContext, type: string, prompt: string, options: RunOptions, managed: ManagedRun): Promise<RunResult> {
  const release = managed.acquireSession?.();
  let primary: unknown;
  try {
    managed.onState?.("starting");
    return await runManagedWorkerSession(ctx, type, prompt, options, managed);
  } catch (error) {
    primary = error;
    managed.onState?.(options.signal?.aborted ? "stopped" : "error");
    throw error;
  } finally { releaseLeases([release], primary); }
}

async function runManagedWorkerSession(ctx: ExtensionContext, type: string, prompt: string, options: RunOptions, managed: ManagedRun): Promise<RunResult> {
  managed.signal = options.signal;
  managed.signal?.throwIfAborted();
  await verifyWorkerWorkspace(options.pi, managed.assertOwner().cwd, managed.cwd, managed.access);
  const { runtime, model } = await createWorkerRuntime(managed);
  const tools = managed.access === "read-only" ? ["read", "grep", "find", "ls"] : ["read", "grep", "find", "ls", "edit", "write", "bash"];
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: managed.cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    systemPromptOverride: () => `${ctx.getSystemPrompt()}\n\n${getAgentConfig(type)?.systemPrompt ?? ""}\n\nYou are a managed ${managed.access} worker. Work only in ${managed.cwd}. Do not delegate. Repository instructions apply.`,
  });
  await runInChildSessionContext(() => loader.reload());
  const sessionManager = managed.resumeSessionFile
    ? SessionManager.open(managed.resumeSessionFile, managed.sessionDirectory, managed.cwd)
    : managed.sessionDirectory ? SessionManager.create(managed.cwd, managed.sessionDirectory) : SessionManager.inMemory(managed.cwd);
  const { session, modelFallbackMessage } = await runInChildSessionContext(() => createAgentSession({
    cwd: managed.cwd, modelRuntime: runtime, model, tools, customTools: [], resourceLoader: loader,
    settingsManager: settings, sessionManager, thinkingLevel: options.thinkingLevel ?? "off",
  }));
  if (modelFallbackMessage || session.model?.provider !== model.provider || session.model.id !== model.id
    || session.thinkingLevel !== (options.thinkingLevel ?? "off")) {
    session.dispose();
    throw new Error("Worker startup effective route or thinking mismatch");
  }
  if ((managed.expectedSessionId && session.sessionManager.getSessionId() !== managed.expectedSessionId)
    || (managed.expectedSystemHash && workerHash(session.systemPrompt) !== managed.expectedSystemHash)) {
    session.dispose();
    throw new Error("Persisted worker identity or context recipe changed; explicit fresh dispatch required");
  }
  let turns = 0;
  let limited = false;
  let initialInvocation = true;
  let initialisationFailed = false;
  const transcriptHash = () => {
    const file = session.sessionManager.getSessionFile();
    return file && existsSync(file) ? workerHash(readFileSync(file, "utf8")) : undefined;
  };
  let settledTranscriptHash: string | undefined;
  let currentText = "";
  session.subscribe(event => {
    if (event.type === "agent_start") { turns = 0; limited = false; }
    if (event.type === "turn_end") {
      turns++;
      if (initialInvocation) options.onTurnEnd?.(turns);
      if (turns >= managed.maxTurns && event.message.role === "assistant" && event.message.stopReason === "toolUse") { limited = true; void session.abort(); }
    }
    if (initialInvocation) {
      if (event.type === "message_start" && event.message.role === "assistant") currentText = "";
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        currentText += event.assistantMessageEvent.delta;
        options.onTextDelta?.(event.assistantMessageEvent.delta, currentText);
      }
      if (event.type === "tool_execution_start") options.onToolActivity?.({ type: "start", toolName: event.toolName });
      if (event.type === "tool_execution_end") options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage) {
      const u = event.message.usage;
      // resumeAgent attaches its own per-invocation accounting subscription.
      if (initialInvocation) options.onAssistantUsage?.({ input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cost: u.cost?.total ?? 0 });
      managed.usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) managed.usage[key] += u[key] ?? 0;
    }
  });
  session.agent.beforeToolCall = async context => {
    managed.assertOwner();
    if (!tools.includes(context.toolCall.name)) return { block: true, reason: "Tool outside managed worker scope" };
  };
  const originalPrompt = session.prompt.bind(session);
  session.prompt = async (...args) => {
    if (initialisationFailed) throw new Error("Worker initialisation failed; explicit fresh dispatch required");
    if (managed.busy) throw new Error("Worker handle is busy");
    managed.busy = true;
    let releaseWriter: (() => void) | undefined;
    let releaseSession: (() => void) | undefined;
    let mayPersist = false;
    let primary: unknown;
    try {
      if (!initialInvocation) {
        releaseSession = managed.acquireSession?.();
        // A different runner may have advanced this transcript while we were idle.
        // Refuse rather than append from an obsolete in-memory leaf.
        if (transcriptHash() !== settledTranscriptHash) throw new Error("Stale live worker transcript; reopen through a fresh runner");
      }
      mayPersist = true;
      managed.signal?.throwIfAborted();
      const writeRoot = await verifyWorkerWorkspace(options.pi, managed.assertOwner().cwd, managed.cwd, managed.access);
      if (writeRoot) {
        if (!managed.acquireWriter) throw new Error("Writer lease service is unavailable");
        releaseWriter = managed.acquireWriter(writeRoot);
      }
      managed.signal?.throwIfAborted();
      validateWorkerRoute(managed.assertOwner(), managed.route, managed.native);
      if (session.model?.provider !== model.provider || session.model.id !== model.id
        || session.thinkingLevel !== (options.thinkingLevel ?? "off")) throw new Error("Worker effective route or thinking mismatch");
      managed.onState?.("running");
      await originalPrompt(...args);
      if (limited) throw new Error("Managed worker turn limit reached; output may be partial");
      const finalMessage = [...session.messages].reverse().find(message => message.role === "assistant");
      // Providers may report errors as terminal messages rather than reject the
      // prompt. Throw here so teardown cannot mask that primary diagnostic.
      if (finalMessage?.stopReason === "error") throw new Error(finalMessage.errorMessage || "Worker provider error");
      managed.onState?.(finalMessage?.stopReason === "aborted" ? "stopped" : "completed");
    } catch (error) {
      primary = error;
      if (mayPersist) managed.onState?.(managed.signal?.aborted ? "stopped" : "error");
      throw error;
    } finally {
      try {
        if (mayPersist) settledTranscriptHash = transcriptHash();
      } finally {
        try { releaseLeases([releaseWriter, releaseSession], primary); } finally { managed.busy = false; }
      }
    }
  };
  managedSessions.set(session, managed);
  try {
    // Do not publish a resumable session until persistence registration succeeds.
    managed.onSession(session);
    options.onSessionCreated?.(session);
  } catch (error) {
    initialisationFailed = true;
    initialInvocation = false;
    managedSessions.delete(session);
    session.dispose();
    throw error;
  }
  const abort = () => { void session.abort(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    await session.prompt(prompt);
  } finally { initialInvocation = false; options.signal?.removeEventListener("abort", abort); }
  const last = [...session.messages].reverse().find(message => message.role === "assistant");
  const responseText = last?.content.filter(item => item.type === "text").map(item => item.text).join("\n") ?? "";
  return { session, responseText, aborted: limited, steered: false, failure: last?.stopReason === "error" ? last.errorMessage ?? "Worker provider error" : undefined };
}
