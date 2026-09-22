# Subscription allowance observations

## Operator constraint

The operator explicitly requires: **no paid model API access or model API keys; Jev is the only paid API exception**. Workers must use existing OAuth subscriptions, with no API-key fallback. The operator has separately confirmed that both OpenAI and xAI accounts are included-usage-only, with paid extras/top-ups unavailable or disabled. That is an account-level attestation, not a guarantee established by the SDK.

## What the data means

The optimisation target is accepted output quality first, then total included allowance consumed by worker, reviewer and repairs. Latency is secondary. Catalogue API prices and raw token counts are not subscription-debit measurements. Different providers' allowance percentages are not interchangeable currencies.

SDK 0.87 exposes `ProviderRequestOptions.onResponse` for passive response observation. No additional requests are needed. Its supported usage type does not expose subscription debits or remaining allowance. Codex's upstream client recognises account-window response headers; observing those headers does not attribute the account's consumption to a particular model or request. Other sessions, reset boundaries, delayed reporting and rounding prevent that inference.

The staging observer retains only bounded, normalised Codex window snapshots. A primary window may be present while another recognised window is incomplete: the whole observation remains `invalid: true` and is unusable for allowance decisions. The Terra/Luna trial returned only such invalid observations; no drain comparison is supported. Missing, malformed and unsupported telemetry remains unknown. xAI request/token rate-limit headers are not treated as subscription allowance. No raw headers, authentication values or credit balances are recorded. Parent-session custom entries are bounded to 32 observations per live managed worker; the final retained entry marks that limit. Observations are diagnostic, not automatic routing or billing authority.

## Sources

- https://developers.openai.com/codex/pricing — explicitly states that credit prices alone do not determine included subscription usage, and that model, context, reasoning, tools, retrieval and caching affect consumption.
- https://raw.githubusercontent.com/openai/codex/eaf81d3f/codex-rs/codex-api/src/rate_limits.rs — pinned upstream parser for Codex primary/secondary used-percent, window-minutes and reset-at headers. Best-effort client contract, not a promise of availability on every response.
- https://docs.x.ai/grok/faq — consumer shared-pool guidance; not proof of the native OAuth/API transport's per-model accounting.
- Installed `pi-ai` 0.87 `dist/types.d.ts`: `ProviderResponse`, `ProviderRequestOptions.onResponse` and `Usage`. `pi-coding-agent` 0.87 `dist/core/sdk.js` always supplies its payload bridge, even for extension-free sessions; managed native calls discard that bridge to prevent arbitrary payload changes without breaking normal SDK dispatch.

## Still not established

Per-model allowance multipliers, attributable per-task debits, cross-provider cost equivalence and monetary savings are unmeasured. The 72-observation Terra/Luna trial passed 67/72 quality checks (Astra 24/24, Terra 23/24, Luna 20/24); neither alternative can be imported under the fail-closed whole-run qualification contract. No proxy-priced auto-ranking should be claimed as cost optimisation. The existing task-family quality and provider-policy correction does not by itself satisfy allowance-aware optimisation. No model receives automatic qualification from these observations.
