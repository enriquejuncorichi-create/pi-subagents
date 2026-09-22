# Per-agent model labels

The fork puts `[provider/model]` immediately beside each agent name, before its mode and description. Long descriptions therefore truncate after model identity, not before it. Running and lingering finished/error rows retain the same identity. The optional thinking annotation remains in the stats.

Identity comes from the agent's invocation snapshot: canonical `modelId` first, then `modelName`. There is no fallback to the main model or agent-type defaults. Unknown identity reads `model pending`; a request without effective identity reads `model pending (requested: …)`. A known mismatch retains `(asked …)`.

Queued agents remain one count in the Agents widget. When an openable queued agent appears in the fleet list, its label reads `selected: …` for a selected identity or `requested: …` for a request alone. Neither claims that the queued agent has started. Session-less queued agents remain outside the navigable fleet, as before.

The extension defaults to the bottom fleet list with model labels enabled and the duplicate above-editor widget off. Both surfaces share a live `showModel` callback, so the Settings toggle updates both immediately. Explicit saved `showModel: false` or `widgetMode` preferences still win. For an existing configuration, choose `/agents → Settings → Widget → off` and `Show model → on` to adopt the bottom-only layout. No installed or personal settings are rewritten by this source change.

The widget retains its 12-line cap, queued-count reservation and overflow accounting. Fleet rows sacrifice right-hand stats before model identity when space is tight. Pi's display-width truncation handles wide characters and combining marks without terminal-specific escape tricks. At widths too small for the name and identity themselves, the identity necessarily truncates; no additional dashboard rows are introduced.

Focused coverage: `test/agent-model-labels.test.ts`, `test/agent-widget.test.ts` and `test/fleet-list.test.ts`. No live model calls are needed. Metadata accuracy still depends on spawn paths supplying truthful invocation snapshots.
