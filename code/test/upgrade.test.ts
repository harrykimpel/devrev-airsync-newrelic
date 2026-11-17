import { spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';

const versionId = 'don:integration:dvrv-us-1:devo/test:snap_in_package/test-package:snap_in_version/test-version';
let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'newrelic-upgrade-'));
  mkdirSync(join(project, 'code/scripts'), { recursive: true });
  mkdirSync(join(project, 'bin'));
  for (const file of ['upgrade.sh', 'devrev-auth.sh']) copyFileSync(resolve(__dirname, '../scripts', file), join(project, 'code/scripts', file));
  writeFileSync(join(project, 'manifest.yaml'), 'version: "2"\n');
  writeFileSync(join(project, 'code/.env'), 'DEV_ORG=test-org\nUSER_EMAIL=developer@example.com\nENV=prod\n');
  writeFileSync(join(project, 'bin/devrev'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.UPGRADE_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'profiles' && args[1] === 'authenticate' && args.includes('--help')) {
  console.log('Usage: devrev profiles authenticate\\n --org string\\n --usr string'); process.exit(0);
}
if (args[0] === 'profiles' && args[1] === 'get-token') {
  console.log(process.env.UPGRADE_TEST_AUTH_FAIL ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z'); process.exit(0);
}
if (args[0] === 'snap_in_version' && args[1] === 'upgrade') {
  if (args.includes('--help')) {
    if (process.env.UPGRADE_TEST_UNSUPPORTED) process.exit(1);
    console.log('Usage: devrev snap_in_version upgrade ' + (process.env.UPGRADE_TEST_IMPLICIT ? '[flags]' : '[id] [flags]') + (process.env.UPGRADE_TEST_LEGACY ? '\\n  --version string  Target version' : '')); process.exit(0);
  }
  process.exit(process.env.UPGRADE_TEST_FAIL ? 1 : 0);
}
console.error('Unexpected command'); process.exit(9);
`, { mode: 0o755 });
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

function run(args: string[] = [versionId], options: { legacy?: boolean; fail?: boolean; authFail?: boolean; unsupported?: boolean; implicitOnly?: boolean; input?: string } = {}) {
  const log = join(project, 'calls.jsonl');
  const result = spawnSync('bash', [join(project, 'code/scripts/upgrade.sh'), ...args], {
    cwd: join(project, 'code'), encoding: 'utf8', timeout: 10000, input: options.input || '',
    env: { ...process.env, PATH: join(project, 'bin') + delimiter + process.env.PATH,
      DEVREV_TOKEN: '', CODESPACES: 'true',
      UPGRADE_TEST_LOG: log, UPGRADE_TEST_LEGACY: options.legacy ? '1' : '',
      UPGRADE_TEST_FAIL: options.fail ? '1' : '', UPGRADE_TEST_AUTH_FAIL: options.authFail ? '1' : '',
      UPGRADE_TEST_UNSUPPORTED: options.unsupported ? '1' : '', UPGRADE_TEST_IMPLICIT: options.implicitOnly ? '1' : '' },
  });
  expect(result.error).toBeUndefined();
  const calls: string[][] = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  // Failure paths must also avoid forced upgrades or replacement installations.
  expect(calls.some((call) => call.includes('--force') || call.includes('create-one') || call.includes('delete-one') || call.includes('draft') || call.includes('activate'))).toBe(false);
  return { ...result, calls, upgrades: calls.filter((call) => call[0] === 'snap_in_version' && call[1] === 'upgrade' && !call.includes('--help')) };
}

test.each([false, true])('upgrades the explicit version using supported syntax (legacy=%s)', (legacy) => {
  const result = run([versionId], { legacy });
  expect(result.status).toBe(0);
  expect(result.upgrades).toEqual([['snap_in_version', 'upgrade', ...(legacy ? ['--version', versionId] : [versionId]), '--path', project, '--org', 'test-org', '--usr', 'developer@example.com']]);
});

test('prompts for an explicit target when no version argument is supplied', () => {
  const result = run([], { input: versionId + '\n' });
  expect(result.status).toBe(0);
  expect(result.upgrades[0]).toContain(versionId);
});

test.each(['', 'newrelic-connector', 'don:integration:example:snap_in_package/test', '--force', versionId + '\nother'])('rejects invalid target %j before authentication', (id) => {
  const result = run([id]);
  expect(result.status).toBe(1);
  expect(result.calls).toEqual([]);
});

test('rejects extra flags, including force', () => {
  const result = run([versionId, '--force']);
  expect(result.status).toBe(1);
  expect(result.calls).toEqual([]);
});

test('does not upgrade when Codespaces authentication has no usable token', () => {
  const result = run([versionId], { authFail: true });
  expect(result.status).toBe(1);
  expect(result.upgrades).toEqual([]);
});

test('does not replace an installation when the CLI lacks upgrade support', () => {
  const result = run([versionId], { unsupported: true });
  expect(result.status).toBe(1);
  expect(result.upgrades).toEqual([]);
});

test('reports upgrade failure without creating a replacement installation', () => {
  const result = run([versionId], { fail: true });
  expect(result.status).toBe(1);
  expect(result.upgrades).toHaveLength(1);
  expect(result.stderr).toContain('Upgrade failed');
});

test('refuses an upgrade that can only target an implicit CLI context', () => {
  const result = run([versionId], { implicitOnly: true });
  expect(result.status).toBe(1);
  expect(result.upgrades).toEqual([]);
  expect(result.stderr).toContain('does not advertise an explicit upgrade target');
});
