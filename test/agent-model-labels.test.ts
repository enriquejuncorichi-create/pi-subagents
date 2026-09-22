import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { AgentWidget, describeActivity, formatAgentModelLabel } from "../src/ui/agent-widget.js";
import { FleetList } from "../src/ui/fleet-list.js";

const theme = { fg: (_colour: string, text: string) => text, bold: (text: string) => text };
function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent", type: "general-purpose", status: "running",
    description: "Build benchmark 界面 é ".repeat(20), startedAt: Date.now(),
    toolUses: 2, lifetimeUsage: { input: 100, output: 100, cacheWrite: 0 }, compactionCount: 0,
    invocation: { modelId: "provider/model", modelName: "Friendly name", thinking: "high" },
    ...overrides,
  };
}
function renderWidget(agent: AgentRecord, width: number, showModel?: () => boolean): string[] {
  const manager = { listAgents: () => [agent] } as unknown as AgentManager;
  const widget = new AgentWidget(manager, new Map(), undefined, undefined, showModel);
  let component: { render(): string[] } | undefined;
  widget.setUICtx({
    setStatus: () => {},
    setWidget: (_key, factory) => {
      component = factory?.({ terminal: { columns: width }, requestRender: () => {} }, theme);
    },
  });
  widget.update();
  const lines = component?.render() ?? [];
  widget.dispose();
  return lines;
}
function renderFleet(agent: AgentRecord, width: number, showModel?: () => boolean): string[] {
  const manager = { listAgents: () => [agent] } as unknown as AgentManager;
  const fleet = new FleetList(manager, new Map(), undefined, undefined, undefined, showModel);
  let component: { render(width: number): string[] } | undefined;
  fleet.setUICtx({
    setWidget: (_key, factory) => { component = factory?.({ requestRender: () => {} }, theme); },
    onTerminalInput: () => () => {}, getEditorText: () => "", notify: () => {},
    custom: async () => { throw new Error("No overlay expected"); },
  });
  fleet.update();
  const lines = component?.render(width) ?? [];
  fleet.dispose();
  return lines;
}

describe("per-agent model identity", () => {
  it("prefers canonical identity and retains request mismatches", () => {
    expect(formatAgentModelLabel(record())).toBe("provider/model");
    expect(formatAgentModelLabel(record({ invocation: { modelId: "actual/model", requestedModel: "wanted" } })))
      .toBe("actual/model (asked wanted)");
  });

  it("distinguishes queued selection, request and unknown identity", () => {
    expect(formatAgentModelLabel(record({ status: "queued" }))).toBe("selected: provider/model");
    expect(formatAgentModelLabel(record({ status: "queued", invocation: { requestedModel: "wanted" } })))
      .toBe("requested: wanted");
    expect(formatAgentModelLabel(record({ status: "queued", invocation: undefined }))).toBe("model pending");
    expect(formatAgentModelLabel(record({ invocation: { requestedModel: "wanted" } })))
      .toBe("model pending (requested: wanted)");
    expect(formatAgentModelLabel(record({ invocation: undefined }))).toBe("model pending");
  });

  it.each(["running", "completed", "error", "aborted", "stopped", "steered"] as const)(
    "keeps identity ahead of long descriptions on %s rows by default", status => {
      const agent = record({ status, completedAt: status === "running" ? undefined : Date.now() });
      for (const width of [40, 80, 240]) {
        const lines = renderWidget(agent, width);
        const row = lines[1];
        expect(row).toContain("[provider/model]");
        if (row.includes("Build benchmark")) expect(row.indexOf("[provider/model]")).toBeLessThan(row.indexOf("Build benchmark"));
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      expect(renderWidget(agent, 240, () => false).join("\n")).not.toContain("provider/model");
    },
  );

  it("never overflows even tiny widths or wide Unicode identities and activity", () => {
    const agent = record({ invocation: { modelId: "供給者/模型é" }, error: "界".repeat(100) });
    for (const width of [1, 2, 5, 15, 40, 80, 240]) {
      for (const line of renderWidget(agent, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(visibleWidth(describeActivity(new Map(), "界".repeat(100)))).toBeLessThanOrEqual(60);
  });

  it.each(["queued", "running", "completed", "error"] as const)(
    "shows an openable %s fleet row without letting stats displace identity", status => {
      const agent = record({ status, completedAt: Date.now(), session: {} as AgentRecord["session"] });
      for (const width of [40, 80, 240]) {
        const lines = renderFleet(agent, width);
        expect(lines.join("\n")).toContain(status === "queued" ? "[selected: provider/model]" : "[provider/model]");
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      expect(renderFleet(agent, 240, () => false).join("\n")).not.toContain("provider/model");
    },
  );

  it("shows a queued request in fleet details and bounds wide identities", () => {
    const queued = record({ status: "queued", session: {} as AgentRecord["session"], invocation: { requestedModel: "wanted" } });
    expect(renderFleet(queued, 80).join("\n")).toContain("[requested: wanted]");
    queued.invocation = { modelId: "供給者/模型é" };
    for (const width of [1, 2, 5, 15, 40, 80, 240]) {
      for (const line of renderFleet(queued, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
