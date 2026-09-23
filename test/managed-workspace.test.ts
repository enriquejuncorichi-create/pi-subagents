import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureRepository } from "../integration/fixture-repository.js";
import { canonicalDirectory, verifyWorkerWorkspace } from "../src/managed-worker-runtime.js";

describe("managed writer Git worktree boundary", () => {
  let fixture: ReturnType<typeof fixtureRepository>;
  let pi: ExtensionAPI;
  beforeAll(() => {
    fixture = fixtureRepository();
    pi = { exec: fixture.exec } as ExtensionAPI;
  });
  afterAll(() => fixture?.dispose());

  it("accepts a registered external linked checkout and its subdirectories", async () => {
    await expect(verifyWorkerWorkspace(pi, fixture.parent, canonicalDirectory(fixture.linked), "write")).resolves.toBe(canonicalDirectory(fixture.linked));
    await expect(verifyWorkerWorkspace(pi, fixture.parent, canonicalDirectory(fixture.nested), "write")).resolves.toBe(canonicalDirectory(fixture.linked));
  });
  it("rejects the parent checkout rather than silently downgrading isolation", async () => {
    await expect(verifyWorkerWorkspace(pi, fixture.parent, canonicalDirectory(fixture.parent), "write")).rejects.toThrow("separate registered linked");
  });
  it("rejects an unrelated Git repository", async () => {
    await expect(verifyWorkerWorkspace(pi, fixture.parent, canonicalDirectory(fixture.unrelated), "write")).rejects.toThrow("separate registered linked");
  });
  it("rejects a missing directory before any dispatch", async () => {
    await expect(verifyWorkerWorkspace(pi, fixture.parent, `${fixture.linked}/missing`, "write")).rejects.toThrow();
  });
});
