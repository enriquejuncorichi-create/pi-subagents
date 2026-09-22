# Local trial and rollback

**Not executed. Explicit user approval is required.** Complete acceptance review first; this procedure changes the active extension configuration.

## Before replacement

1. Finish or stop existing subagents and exit their Pi sessions. Do not hot-swap a runner underneath live workers.
2. Back up `~/.pi/agent/settings.json` and any existing global/project `subagents.json`, preserving exact bytes and noting the backup paths.
3. Confirm the Pi host is 0.87.0 or newer and the local runner/companion paths are present. These development checkouts are not a published package.
4. Record the existing `npm:@tintinweb/pi-subagents` package entry and any separately configured runner extension paths. Preserve every unrelated package and preference.

## Approved activation

Replace the upstream runner registration with the absolute local `pi-subagents` checkout path; do not load both. Add the local `pi-jev-assist` package only if it is not already registered. Use Pi's documented local-package mechanism, not edits to installed package contents.

For the requested UI, set the effective preferences to `fleetView: true`, `widgetMode: "off"`, `showModel: true`. Existing project settings override global settings, so inspect the actual project before changing anything. If the fields are absent, the fork already supplies these defaults and no preference write is needed.

Start a fresh Pi session. Check that exactly one Agent tool/runner is registered; the bottom fleet remains visible; no duplicate top widget appears; running and completed rows show the resolved model; and unknown/pending routes are not mislabelled as effective models. Verify normal direct delegation still works before enabling Jev routing.

Routing defaults off. Enabling routing must not change the parent's model/thinking. Without user-approved qualifications, it uses only the explicit eligible baseline. A completed benchmark does not automatically grant trust.

## Rollback

Exit trial sessions after stopping their workers. Restore the exact backed-up configuration bytes, including the original upstream package entry and display preferences, then start a fresh Pi session. Do not delete worker transcripts, manifests, locks or worktrees during rollback. Investigate any interrupted work and active leases separately; no prompt replay is implied by restoring configuration.

Linux uses the equivalent home-directory paths and absolute local package registrations. No Windows-specific checkout path should be copied into a Linux configuration.
