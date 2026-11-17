import { spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';

const scripts = resolve(__dirname, '../scripts');
let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'newrelic-deployment-auth-'));
  mkdirSync(join(project, 'code/scripts'), { recursive: true });
  mkdirSync(join(project, 'bin'));
  for (const file of readdirSync(scripts).filter((name) => name.endsWith('.sh'))) {
    copyFileSync(join(scripts, file), join(project, 'code/scripts', file));
  }
  writeFileSync(join(project, 'manifest.yaml'), 'service_account:\n  scopes:\n    self:\n      - scope: sync_snap_in:all\n');
  writeFileSync(join(project, 'code/package.json'), '{}');
  writeFileSync(join(project, 'bin/tput'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  // Only the empty package list is needed; the tests never create or delete objects.
  writeFileSync(join(project, 'bin/jq'), `#!/bin/bash
case "$*" in
  *length*) echo 0 ;;
  -s*) echo '[]' ;;
  *) cat ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(project, 'bin/devrev'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DEVREV_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'profiles' && args[1] === 'authenticate' && args.includes('--help')) {
  const selector = process.env.DEVREV_TEST_ENV_FLAG;
  console.log('Flags:\\n  --expiry int\\n  --env-var-token string\\nGlobal Flags:\\n  --org string\\n  --usr string' + (selector ? '\\n  ' + selector + ' string  Environment' : ''));
  process.exit(0);
}
if (args[0] === 'profiles' && args[1] === 'get-token') {
  console.log(process.env.DEVREV_TEST_EXPIRY || '2000-01-01 00:00:00 +0000 UTC');
  process.exit(0);
}
if (args[0] === 'profiles' && args[1] === 'authenticate') {
  if ((args.includes('--env') && process.env.DEVREV_TEST_ENV_FLAG !== '--env') || (args.includes('-e') && process.env.DEVREV_TEST_ENV_FLAG !== '-e')) {
    console.error('unknown authentication flag');
    process.exit(2);
  }
  process.exit(process.env.DEVREV_TEST_AUTH_FAIL === '1' ? 1 : 0);
}
if (args[0] === 'snap_in_package' && args[1] === 'list') {
  console.log('[]');
  process.exit(0);
}
if (args[0] === 'snap_in_package' && args[1] === 'create-one') {
  console.error('Test stopped before creating a package');
  process.exit(1);
}
console.error('Unexpected CLI call: ' + args.join(' '));
process.exit(2);
`, { mode: 0o755 });
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

function run(script: string, options: { environment?: string; authFails?: boolean; tokenExpiry?: string; envFlag?: string } = {}) {
  const { environment = 'prod', authFails = false, tokenExpiry = '', envFlag = '' } = options;
  writeFileSync(join(project, 'code/.env'), `DEV_ORG=test-org\nUSER_EMAIL=developer@example.com\nENV=${environment}\n`);
  const log = join(project, 'cli-calls.jsonl');
  const result = spawnSync('bash', [join(project, 'code/scripts', script)], {
    cwd: project,
    encoding: 'utf8',
    timeout: 10000,
    // Down + Enter chooses Lambda, followed by the organization/email/slug defaults.
    input: script === 'deploy.sh' ? '\x1b[B\n\n\n\n' : '\n\n',
    env: {
      ...process.env,
      PATH: join(project, 'bin') + delimiter + process.env.PATH,
      DEVREV_TEST_LOG: log,
      DEVREV_TEST_AUTH_FAIL: authFails ? '1' : '0',
      DEVREV_TEST_EXPIRY: tokenExpiry,
      DEVREV_TEST_ENV_FLAG: envFlag,
    },
  });
  expect(result.error).toBeUndefined();
  const calls: string[][] = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { ...result, calls };
}

describe.each(['deploy.sh', 'cleanup.sh'])('%s authentication', (script) => {
  test('authenticates production using flags supported by the current CLI', () => {
    const result = run(script);
    expect(result.calls).toContainEqual([
      'profiles', 'authenticate', '--usr', 'developer@example.com', '--org', 'test-org', '--expiry', '5',
    ]);
    expect(result.calls).toContainEqual(['profiles', 'get-token', 'expiry', '--org', 'test-org', '--usr', 'developer@example.com']);
    expect(result.stdout).toContain('Authenticated');
    // Deployment intentionally stops at the mocked create; cleanup sees an empty list.
    expect(result.status).toBe(script === 'deploy.sh' ? 1 : 0);
  });

  test.each([
    '2099-01-01 00:00:00.000000000 +0000 UTC',
    '2099-01-01 05:30:00.000 +0530 IST',
    '2099-01-01T00:00:00Z',
  ])('reuses a valid token for the selected profile with expiry %s', (tokenExpiry) => {
    const result = run(script, { tokenExpiry });
    expect(result.calls).toContainEqual(['profiles', 'get-token', 'expiry', '--org', 'test-org', '--usr', 'developer@example.com']);
    expect(result.calls.some((args) => args[1] === 'authenticate' && !args.includes('--help'))).toBe(false);
    expect(result.stdout).toContain('Already authenticated');
    expect(result.status).toBe(script === 'deploy.sh' ? 1 : 0);
  });

  test('preserves the numeric timezone when deciding whether a cached token expired', () => {
    const tokenExpiry = new Date(Date.now() + 4 * 3600000).toISOString().replace('T', ' ').replace('Z', ' +0500 CUSTOM');
    const result = run(script, { tokenExpiry });
    expect(result.calls).toContainEqual([
      'profiles', 'authenticate', '--usr', 'developer@example.com', '--org', 'test-org', '--expiry', '5',
    ]);
    expect(result.stdout).not.toContain('Already authenticated');
  });

  test('stops before package operations when authentication fails', () => {
    const result = run(script, { authFails: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('DevRev authentication failed');
    expect(result.calls.some((args) => args[0] === 'snap_in_package')).toBe(false);
  });

  test('rejects nonproduction environments when the CLI has no environment selector', () => {
    const result = run(script, { environment: 'qa' });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([['profiles', 'authenticate', '--help']]);
  });

  test.each(['--env', '-e'])('uses the legacy %s environment selector only when advertised', (envFlag) => {
    const result = run(script, { environment: 'qa', envFlag });
    expect(result.calls).toContainEqual([
      'profiles', 'authenticate', envFlag, 'qa', '--usr', 'developer@example.com', '--org', 'test-org', '--expiry', '5',
    ]);
    expect(result.calls).toContainEqual(['profiles', 'get-token', 'expiry', envFlag, 'qa', '--org', 'test-org', '--usr', 'developer@example.com']);
    expect(result.stdout).toContain('Authenticated');
    expect(result.status).toBe(script === 'deploy.sh' ? 1 : 0);
  });
});
