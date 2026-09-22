import { execFile, execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { digest, gradeArtifact, hiddenProbe, type CodingCase } from '../../pi-jev-assist/bench/accepted-result-suite.js';

export const exec: ExtensionAPI['exec'] = (command, args, options) => new Promise(resolveResult => {
  execFile(command, args, { timeout: options?.timeout ?? 10_000, windowsHide: true }, (error, stdout, stderr) => {
    resolveResult({ code: error ? 1 : 0, killed: Boolean(error?.killed), stdout, stderr });
  });
});

export interface FixtureSpawnDiagnostic {
  attempt: number;
  code: string | null;
  syscall: string | null;
  messageFingerprint: string;
  elapsedMs: number;
  willRetry: boolean;
}

/** Retry only a timed-out Windows read, never fixture mutations or model calls. */
export function readFixtureGit(read: () => string, diagnostics: FixtureSpawnDiagnostic[], platform: NodeJS.Platform = process.platform): string {
  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    try {
      return read();
    } catch (error) {
      const detail = error as { code?: unknown; syscall?: unknown; message?: unknown; status?: unknown } | null;
      const code = typeof detail?.code === 'string' ? detail.code : null;
      const syscall = typeof detail?.syscall === 'string' ? detail.syscall : null;
      // Both retained trial fingerprints identify "spawnSync git ETIMEDOUT".
      // The underlying stall is unproven. A second read may recover; it must still
      // produce real Git output. Non-zero exits and all other failures stay fatal.
      const willRetry = platform === 'win32' && attempt === 1 && code === 'ETIMEDOUT'
        && syscall === 'spawnSync git' && detail?.status == null;
      diagnostics.push({ attempt, code, syscall, messageFingerprint: digest(typeof detail?.message === 'string' ? detail.message : String(error)), elapsedMs: performance.now() - started, willRetry });
      if (!willRetry) throw error;
    }
  }
}

/** No user's repository is changed. Retain temporary artefacts for inspection, no automatic deletion. */
export function createFixture(item: CodingCase) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'jev-accepted-')));
  const parent = join(root, 'seed');
  const linked = join(root, 'worker');
  const hooks = join(root, 'empty-hooks');
  mkdirSync(hooks);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=' + hooks, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet', parent);
  for (const [key, value] of Object.entries({ 'commit.gpgsign': 'false', 'tag.gpgsign': 'false', 'core.hooksPath': hooks, 'core.autocrlf': 'false' })) git('-C', parent, 'config', '--local', key, value);
  const files = { ...item.files, 'ACCEPTANCE.md': item.spec, ...(item.publicTest ? { 'public.test.mjs': item.publicTest } : {}) };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(parent, path), content);
  git('-C', parent, 'add', '--', ...Object.keys(files));
  git('-C', parent, '-c', 'user.name=Benchmark Fixture', '-c', 'user.email=benchmark@example.invalid', 'commit', '--quiet', '-m', 'test: synthetic acceptance fixture');
  const head = git('-C', parent, 'rev-parse', 'HEAD').trim();
  git('-C', parent, 'worktree', 'add', '--quiet', '--detach', linked, head);
  const spawnDiagnostics: FixtureSpawnDiagnostic[] = [];
  const snapshotGit = (...args: string[]) => readFixtureGit(() => git(...args), spawnDiagnostics);
  const snapshot = () => {
    // Include staged, unstaged, untracked and deletions; worker commits cannot hide changes.
    const changed = snapshotGit('-C', linked, 'diff', '--name-only', '-z', head).split('\0').filter(Boolean);
    const untracked = snapshotGit('-C', linked, 'ls-files', '--others', '-z').split('\0').filter(Boolean);
    const paths = [...new Set([...changed, ...untracked])].sort();
    const hashes = Object.fromEntries(paths.map(path => {
      try { return [path, digest(readFileSync(resolve(linked, path), 'utf8'))]; } catch { return [path, 'deleted-or-unreadable']; }
    }));
    const parentUnchanged = Object.entries(files).every(([path, content]) => {
      try { return readFileSync(join(parent, path), 'utf8') === content; } catch { return false; }
    }) && snapshotGit('-C', parent, 'status', '--porcelain').trim() === '' && snapshotGit('-C', parent, 'rev-parse', 'HEAD').trim() === head;
    return { paths, hashes, diff: snapshotGit('-C', linked, 'diff', '--no-ext-diff', '--no-textconv', head, '--'), parentUnchanged, passed: parentUnchanged && paths.every(path => item.allowed.includes(path) && (() => { try { return lstatSync(resolve(linked, path)).isFile(); } catch { return false; } })()), spawnDiagnostics: [...spawnDiagnostics] };
  };
  return { root, parent, linked, head, snapshot, spawnDiagnostics, contextFingerprint: digest(JSON.stringify(files)) };
}

export interface Check { publicPassed: boolean; hiddenPassed: boolean; scopePassed: boolean; evidence: string }
export async function checkFixture(item: CodingCase, fixture: ReturnType<typeof createFixture>, output: string, bun: string, nonce: string): Promise<Check> {
  const scopePassed = fixture.snapshot().passed;
  if (!item.publicTest) {
    const passed = gradeArtifact(item.id, output);
    return { publicPassed: true, hiddenPassed: passed, scopePassed, evidence: 'controller structured-artifact oracle' };
  }
  const sentinel = digest(`completed:${nonce}`);
  const run = (input: string): Promise<boolean> => new Promise(resolveResult => {
    const child = execFile(bun, ['run', '-'], { cwd: fixture.linked, timeout: 10_000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 128 * 1024 }, (error, stdout) => resolveResult(!error && stdout.trim() === sentinel));
    // A candidate calling process.exit(0) must not turn skipped assertions into a pass.
    child.stdin?.on('error', () => {});
    child.stdin?.end(`${input}\nconsole.log(${JSON.stringify(sentinel)});\n`);
  });
  const publicPassed = await run(`await import(${JSON.stringify(pathToFileURL(join(fixture.linked, 'public.test.mjs')).href)});`);
  // Probe text/data enters stdin only after managed sessions are disposed. Nothing is written into the checkout.
  const hiddenPassed = await run(hiddenProbe(item.id, pathToFileURL(join(fixture.linked, 'solution.mjs')).href, nonce));
  return { publicPassed, hiddenPassed, scopePassed, evidence: 'public test and 17 generated held-out variations; 10s subprocess deadline each' };
}
