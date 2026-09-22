import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** All commits and cleanup are confined to a newly created synthetic repository. */
export function fixtureRepository() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "jev-worker-fixture-")));
  const parent = join(root, "parent");
  const linked = join(root, "linked");
  const unrelated = join(root, "unrelated");
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet", parent);
  writeFileSync(join(parent, "value.ts"), "export const value = 1;\n");
  git("-C", parent, "add", "value.ts");
  git("-C", parent, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "test: seed synthetic fixture");
  git("-C", parent, "worktree", "add", "--quiet", "--detach", linked, "HEAD");
  git("init", "--quiet", unrelated);
  const nested = join(linked, "nested");
  mkdirSync(nested);
  const exec: ExtensionAPI["exec"] = (command, args, options) => new Promise(resolve => {
    execFile(command, args, { timeout: options?.timeout ?? 10_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, killed: Boolean(error?.killed), stdout, stderr });
    });
  });
  return { root, parent, linked, unrelated, nested, exec, dispose: () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) };
}
