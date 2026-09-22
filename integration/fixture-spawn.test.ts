import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkFixture, readFixtureGit, type FixtureSpawnDiagnostic } from './live-benchmark-fixtures.js';
import { digest, type CodingCase } from '../../pi-jev-assist/bench/accepted-result-suite.js';

const timeout = () => Object.assign(new Error('spawnSync git ETIMEDOUT'), {
  name: 'SystemError', code: 'ETIMEDOUT', syscall: 'spawnSync git', status: null, signal: 'SIGTERM',
});
const git = (...args: string[]) => execFileSync('git', args, {
  encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
});

describe('fixture snapshot subprocess recovery (offline)', () => {
  test('identifies the retained trials as Git timeouts', () => {
    expect(digest(timeout().message)).toBe('6610d55856bb585cd45998bac420f561b29df5978f22a85a8263830abb924ce4');
  });

  test('one Windows timeout retries the read and retains diagnostics alongside real Git output', () => {
    const diagnostics: FixtureSpawnDiagnostic[] = [];
    let calls = 0;
    const result = readFixtureGit(() => {
      if (++calls === 1) throw timeout();
      return git('--version');
    }, diagnostics, 'win32');
    expect(result).toStartWith('git version');
    expect(calls).toBe(2);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ attempt: 1, code: 'ETIMEDOUT', syscall: 'spawnSync git', willRetry: true, messageFingerprint: digest(timeout().message) });
  });

  test('persistent timeouts throw the original final error after exactly two attempts', () => {
    const diagnostics: FixtureSpawnDiagnostic[] = [];
    const final = timeout();
    let calls = 0;
    expect(() => readFixtureGit(() => { calls++; throw final; }, diagnostics, 'win32')).toThrow(final);
    expect(calls).toBe(2);
    expect(diagnostics.map(item => item.willRetry)).toEqual([true, false]);
  });

  test('a Git command failure after a timeout is not treated as successful scope', () => {
    const diagnostics: FixtureSpawnDiagnostic[] = [];
    let calls = 0;
    expect(() => readFixtureGit(() => {
      if (++calls === 1) throw timeout();
      return git('-C', join(tmpdir(), `missing-fixture-${crypto.randomUUID()}`), 'status', '--porcelain');
    }, diagnostics, 'win32')).toThrow();
    expect(calls).toBe(2);
    expect(diagnostics.map(item => item.willRetry)).toEqual([true, false]);
  });

  test.each([
    ['non-zero exit', Object.assign(timeout(), { status: 128 }), 'win32'],
    ['missing executable', Object.assign(timeout(), { code: 'ENOENT' }), 'win32'],
    ['permission denied', Object.assign(timeout(), { code: 'EACCES' }), 'win32'],
    ['buffer overflow', Object.assign(timeout(), { code: 'ENOBUFS' }), 'win32'],
    ['unclassified SystemError', Object.assign(timeout(), { code: undefined }), 'win32'],
    ['other subprocess', Object.assign(timeout(), { syscall: 'spawnSync bun' }), 'win32'],
    ['non-Windows timeout', timeout(), 'linux'],
  ] as const)('does not retry %s', (_label, error, platform) => {
    let calls = 0;
    const diagnostics: FixtureSpawnDiagnostic[] = [];
    expect(() => readFixtureGit(() => { calls++; throw error; }, diagnostics, platform)).toThrow(error);
    expect(calls).toBe(1);
    expect(diagnostics[0]?.willRetry).toBe(false);
  });

  test('successful empty output is returned without retry or diagnostic', () => {
    const diagnostics: FixtureSpawnDiagnostic[] = [];
    let calls = 0;
    expect(readFixtureGit(() => { calls++; return ''; }, diagnostics, 'win32')).toBe('');
    expect(calls).toBe(1);
    expect(diagnostics).toEqual([]);
  });

  test('checkFixture propagates snapshot exhaustion rather than grading it', async () => {
    const error = timeout();
    const spawnDiagnostics: FixtureSpawnDiagnostic[] = [];
    const fixture = {
      root: '', parent: '', linked: '', head: '', contextFingerprint: '', spawnDiagnostics,
      snapshot: (): never => { readFixtureGit(() => { throw error; }, spawnDiagnostics, 'win32'); throw new Error('unreachable'); },
    };
    const item: CodingCase = { id: 'offline', role: 'scout', spec: '', files: {}, allowed: [], publicTest: null };
    await expect(checkFixture(item, fixture, '', process.execPath, 'offline')).rejects.toBe(error);
    expect(spawnDiagnostics).toHaveLength(2);
  });
});
