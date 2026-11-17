import { spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';

const scripts = resolve(__dirname, '../scripts');
let project: string;
const packageId = 'don:integration:example:devo/test:snap_in_package/new';
const versionId = `${packageId}:snap_in_version/new`;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'newrelic-deployment-errors-'));
  mkdirSync(join(project, 'code/scripts'), { recursive: true });
  mkdirSync(join(project, 'bin'));
  for (const file of readdirSync(scripts).filter((name) => name.endsWith('.sh'))) copyFileSync(join(scripts, file), join(project, 'code/scripts', file));
  writeFileSync(join(project, 'manifest.yaml'), 'service_account:\n  scopes:\n    self:\n      - scope: sync_snap_in:all\n');
  writeFileSync(join(project, 'code/package.json'), '{}');
  writeFileSync(join(project, 'code/.env'), 'DEV_ORG=test-org\nUSER_EMAIL=developer@example.com\nENV=prod\n');
  for (const name of ['tput', 'sleep']) writeFileSync(join(project, 'bin', name), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(project, 'bin/devrev'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify(args) + '\\n');
const command = args.slice(0, 2).join(' ');
const mode = process.env.DEPLOY_TEST_MODE;
if (command === 'profiles authenticate' && args.includes('--help')) { console.log('Flags: --expiry int'); process.exit(0); }
if (command === 'profiles get-token') { console.log('2099-01-01T00:00:00Z'); process.exit(0); }
if (command === 'snap_in_package create-one') { console.log(JSON.stringify({snap_in_package:{id:${JSON.stringify(packageId)}}})); process.exit(0); }
if (command === 'snap_in_package delete-one') { console.log('cleaned'); process.exit(0); }
if (command === 'snap_in_version create-one') {
  console.log('> build\\n> prepackage\\n> package\\ndist/index.js');
  if (mode === 'version-json-zero') { console.log('\\x1b[31m' + JSON.stringify({debug_message:'following scopes do not exist: [comment:write]',message:'Bad Request',type:'bad_request'}) + '\\x1b[0m'); process.exit(0); }
  if (mode === 'version-nonzero') { console.error('version creation failed'); process.exit(7); }
  if (mode === 'version-missing-id') { console.log('{}'); process.exit(0); }
  console.log(JSON.stringify({snap_in_version:{id:${JSON.stringify(versionId)}}})); process.exit(0);
}
if (command === 'snap_in_version show') { console.log(JSON.stringify({snap_in_version:{state:'ready'}})); process.exit(0); }
if (command === 'snap_in draft' || command === 'snap_in activate') {
  const step = command.split(' ')[1];
  if (mode === step + '-json-zero') { console.log(JSON.stringify({message:step + ' denied',type:'forbidden'})); process.exit(0); }
  if (mode === step + '-nonzero') { console.error(step + ' failed'); process.exit(9); }
  console.log(JSON.stringify({snap_in:{id:'new-installation'}})); process.exit(0);
}
console.error('Unexpected call: ' + args.join(' ')); process.exit(8);
`, { mode: 0o755 });
  // Simulate util-linux script's logging and optional propagation of the child exit code.
  writeFileSync(join(project, 'bin/script'), `#!${process.execPath}
const fs = require('fs');
const {spawnSync} = require('child_process');
const args = process.argv.slice(2);
const command = args[args.indexOf('-c') + 1];
const result = spawnSync('bash', ['-c', command], {encoding:'utf8',env:process.env});
const output = 'Script started\\n' + result.stdout + result.stderr + '\\nScript done [COMMAND_EXIT_CODE="' + result.status + '"]\\n';
fs.writeFileSync(args[args.length-1], output);
process.stdout.write(output);
process.exit(args.includes('-e') ? result.status : 0);
`, { mode: 0o755 });
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

function run(mode: string) {
  const log = join(project, 'calls.jsonl');
  const result = spawnSync('bash', [join(project, 'code/scripts/deploy.sh')], {
    cwd: project, encoding: 'utf8', timeout: 10000, input: '\x1b[B\n\n\n\n',
    env: { ...process.env, OSTYPE: 'linux-gnu', PATH: join(project, 'bin') + delimiter + process.env.PATH,
      DEVREV_TOKEN: '', CODESPACES: 'true', DEPLOY_TEST_LOG: log, DEPLOY_TEST_MODE: mode },
  });
  expect(result.error).toBeUndefined();
  const calls: string[][] = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { ...result, calls };
}

test.each(['version-json-zero', 'version-nonzero', 'version-missing-id'])('fails %s and only cleans up the newly created package', (mode) => {
  const result = run(mode);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain(mode === 'version-missing-id' ? 'Failed to get version ID' : 'Failed to create snap-in version');
  expect(result.calls.filter((args) => args[1] === 'delete-one')).toEqual([['snap_in_package', 'delete-one', packageId]]);
  expect(result.calls.some((args) => args[1] === 'draft' || args[1] === 'activate')).toBe(false);
  expect(result.stdout).not.toContain('Lambda deployment complete');
  if (mode === 'version-json-zero') expect(result.stdout).toContain('following scopes do not exist');
});

test.each(['draft-json-zero', 'draft-nonzero', 'activate-json-zero', 'activate-nonzero'])('does not claim a successful deployment after %s', (mode) => {
  const result = run(mode);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain(mode.startsWith('draft') ? 'Failed to create draft' : 'Failed to activate snap-in');
  expect(result.stdout).not.toContain('Lambda deployment complete');
  expect(result.calls.some((args) => args[1] === 'delete-one')).toBe(false);
  if (mode.startsWith('draft')) expect(result.calls.some((args) => args[1] === 'activate')).toBe(false);
});

test('accepts valid version JSON among packaging and script logs, then drafts and activates', () => {
  const result = run('success');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Lambda deployment complete');
  expect(result.calls).toContainEqual(['snap_in', 'draft', '--snap_in_version', versionId]);
  expect(result.calls).toContainEqual(['snap_in', 'activate']);
  expect(result.calls.some((args) => args[1] === 'delete-one')).toBe(false);
});
