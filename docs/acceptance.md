# Managed-worker acceptance record

This is a verification record, not installation approval. No development changes have been installed, committed or published. Alternative routes remain unqualified unless separately reviewed and approved through Jev's interactive import.

## Implemented contract

- Parent model and thinking are retained; workers use exact native subscription routes with no API-key fallback.
- Codex requests use SSE and zero native retries. A trusted benchmark reservation hook bounds request/output allocations before the native boundary.
- Read-only workers have no shell or mutation tools. Writers require a separate registered linked worktree. Neither mode is an OS sandbox against the same account.
- Persistent recovery binds parent session identity/file, canonical workspace, exact route, thinking and system-prompt recipe. Leases and transcript freshness checks refuse concurrent or stale recovery.
- Interrupted prompts are not replayed. Ordinary mention tombstones cannot resurrect managed transcripts outside managed protection.
- Bottom fleet rows show actual model identity; top widget defaults off. Explicit saved preferences remain respected.
- Qualification import validates bounded, hashed completed evidence and recomputes coverage, usage and paired metrics. Approval is interactive and never automatic.

## SDK compatibility

The development runner now targets Pi 0.87.0, matching the installed host catalogue containing `openai-codex/gpt-6-astra`. The earlier 0.84.2 catalogue did not contain that baseline and preflight correctly refused it. The mention clone uses the supported resource-loader prompt override. Faux-provider tests reconstruct SDK 0.87's system-message tool/prompt representation without changing real transcripts.

## Executed checks

- Windows managed runtime/store: 12 passed before SDK alignment; aligned managed runtime/store/catalogue/workspace group: 29 passed.
- Windows real SDK recovery/client contract with simulated providers: three passed on SDK 0.87.
- Windows model-label/settings group: 135 passed; lifecycle/mention group: 74 passed.
- Windows mention clone: 23 passed. Runner lint passed; TypeScript build emitted JavaScript/declarations into a temporary directory.
- Windows benchmark budget/evidence group: 22 passed. Converter/import/control group: 29 passed. Subsequent routing checks: 21 passed and Jev typecheck passed.
- Windows snapshot timeout guard: 13 passed. Only a classified read-only Git timeout receives one retry; other failures remain fatal.
- Linux SDK-aligned targeted snapshot: both typechecks passed; 161 runner/UI tests, three recovery tests and 36 Jev/benchmark tests passed.
- Latest integrated Windows runner suite: 2,142 passed, 33 failed, nine skipped. Remaining failures concern path/line-ending expectations, symlink permissions and temporary-file access/cleanup; the full gate is not green.
- Integrated Linux runner suite: 2,173 passed, four failed, seven skipped. Three failures reproduced in untouched upstream: workflow stack-line numbering under Bun, template line endings and filesystem enumeration ordering. The fourth was an equal-millisecond fixture ordering assumption; a deterministic clock correction subsequently passed all 13 workflow-command tests.
- Integrated Linux Jev suite: 184 passed, nine failed. The same nine failures reproduced in untouched Jev (132 passed), involving existing script/runtime and missing-command assumptions.

These are bounded checks on particular source snapshots, not a guarantee about all behaviour. Baseline failures are disclosed rather than suppressed. No claim of a green complete test suite is made.

## Live evidence

Exact Astra/Sol native subscription preflight passed without inference after SDK alignment. The first accepted-result run and diagnostic run remain immutable incomplete evidence in the sibling Jev `bench/results` directory. The initial worker edited a synthetic fixture successfully; controller Git snapshot reads timed out after 15 seconds before review. Public and hidden checks passed when run locally against the retained fixture. Error fingerprints identified `spawnSync git ETIMEDOUT`; the underlying stall is unproven.

A later bounded paired trial is still under evaluation. Until it completes and is reviewed, no live accepted-result qualification or efficiency conclusion is established. Catalogue list-price equivalents are not subscription charges; remaining quota and cache residency remain unknown.
