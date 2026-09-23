# Jev development fork

Local package: `enrique-pi-subagents@0.19.0-jev.1`, based on upstream `@tintinweb/pi-subagents@0.19.0` at `e955e29`.

The package is private and **not approved for installation or publication yet**. Its repository metadata continues to identify the upstream source; no published fork URL is implied. Do not load this alongside upstream: the trial must replace the runner registration, not duplicate it.

## Added capability

`managed-workers-v1` provides exact-route, subscription-only dispatch with opaque owned handles. See [the RPC contract](rpc.md#managed-workers-v1).

- Native Codex and xAI routes only. Anthropic remains billing-unverified.
- No parent model/thinking changes or automatic paid fallback.
- Read-only workers have no shell, mutation tools or ambient extensions.
- Writers require an externally provided linked worktree of the parent repository. A worktree is **not an OS security sandbox**.
- Resume retains the SDK session. Persistent workers can be reopened only by the same persistent parent session and canonical workspace; ephemeral-parent handles cannot survive restart.
- Interrupted workers are never replayed automatically. Session and writer leases exclude competing runners; a stale in-memory transcript is refused rather than branched.
- Cancellation, token accounting and existing completion notifications are preserved.
- Cache counters report SDK observations, not proof of residency or actual monetary savings.

Provider definitions come from a private configuration-free `ModelRuntime` catalogue. Do not reintroduce static `pi-ai/providers/*` imports into the extension graph: the tested Pi extension loader resolved that path beneath its `compat.js` alias and prevented the entire extension loading. Catalogue initialisation failures are not silently retried.

## Recovery and reconciliation

Manifests and transcripts live below Pi's agent directory in `managed-workers-v1`, partitioned by parent-session identity and canonical workspace. Handles are opaque UUIDs, not transcript paths. Recovery checks the saved route, thinking level, session identity and system-prompt fingerprint before making a model call.

A `starting` or `running` manifest after restart is reported as interrupted. Inspect the old process, transcript and any worktree changes before deciding what to do next. Do not delete `active.lock` or a `writer-locks` entry while any owning process may still be alive. Locks are never stolen using PID guesses. After human reconciliation, prefer a fresh dispatch; the runner does not automatically replay the interrupted prompt or mark it successful.

Stored transcripts are local sensitive data and have no automatic retention purge. Removing them or their locks is an explicit operator action, not part of normal startup. Keep the store on a local filesystem with atomic same-directory rename support. Worktrees and private file modes are not an OS sandbox against a worker running under the same account.

## Verification commands

```sh
bun run typecheck
bun run test test/managed-catalogue.test.ts test/managed-workers.test.ts test/managed-workers-runtime.test.ts test/managed-workspace.test.ts test/cross-extension-rpc.test.ts
bun run test:jev-contract
bun test integration/managed-recovery.test.ts
```

The opt-in combined contract test requires the `pi-jev-assist` checkout beside this checkout, under that directory name. It imports the actual Jev client rather than a copied protocol stub. It uses real RPC handlers, the real manager and SDK sessions, with synthetic in-memory credentials and provider responses. It makes no external model calls.

Writer fixtures initialise and commit only within fresh temporary synthetic repositories. They never commit changes in either development checkout.

## Current validation limits

The latest full runner suite before the final safety-accounting changes reported 2,117 passed, 22 failed and 9 skipped. The untouched upstream run reported 2,098 passed, 29 failed and 9 skipped. Failure sets vary because Windows temporary-directory cleanup is intermittent; fewer failures is not a green regression gate. Platform-dependent path, symlink permission, line-ending and cleanup failures remain unresolved.

An isolated Linux snapshot passed both projects' typechecks, 158 runner/UI tests, three recovery/contract integration tests and 31 Jev/benchmark tests. Later source edits require fresh verification; these figures are not a final completion gate.

Successful simulated-provider tests are not live subscription-path proof or model-quality qualification. The Jev microbenchmarks are diagnostic only; live accepted-result evidence and final independent review remain acceptance requirements.
