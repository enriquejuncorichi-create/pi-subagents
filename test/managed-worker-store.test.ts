import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedWorkerStore, type StoredWorker } from "../src/managed-worker-store.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "managed-store-test-")));
  temporary.push(root);
  const parentFile = join(root, "parent.jsonl");
  writeFileSync(parentFile, "{}\n");
  const store = new ManagedWorkerStore(join(root, "store"));
  const record: StoredWorker = {
    version: 1, owner: { id: randomUUID(), parentFile, workspace: root }, handle: randomUUID(),
    type: "general-purpose", route: { provider: "openai-codex", model: "fixture" },
    cwd: root, access: "read-only", maxTurns: 3, state: "completed", updatedAt: 1,
  };
  store.save(record);
  return { store, record };
}

describe("managed store lease ownership", () => {
  it("refuses a stale snapshot under the lease and releases only its own claim", () => {
    const { store, record } = fixture();
    const advanced = { ...record, updatedAt: 2 };
    store.save(advanced);
    expect(() => store.acquireSession(record)).toThrow("Stale worker manifest");
    expect(store.load(record.owner, record.handle)).toEqual(advanced);
    const release = store.acquireSession(advanced);
    release();
    release();
  });

  it("never removes a replacement owner's lock when release fails", () => {
    const { store, record } = fixture();
    const release = store.acquireSession(record);
    const lock = join(store.sessionDirectory(record.owner, record.handle), "active.lock");
    const replacement = JSON.stringify({ handle: randomUUID(), token: randomUUID(), pid: process.pid });
    writeFileSync(lock, replacement);
    expect(() => release()).toThrow("ownership changed");
    expect(readFileSync(lock, "utf8")).toBe(replacement);
    expect(() => store.acquireSession(record)).toThrow("leased or interrupted");
    expect(existsSync(lock)).toBe(true);
  });

  it("refuses corrupt manifests without retaining the acquisition lock", () => {
    const { store, record } = fixture();
    const folder = store.sessionDirectory(record.owner, record.handle);
    writeFileSync(join(folder, "manifest.json"), "{");
    expect(() => store.acquireSession(record)).toThrow("Corrupt worker manifest");
    expect(existsSync(join(folder, "active.lock"))).toBe(false);
  });
});
