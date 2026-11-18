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
  if (mode === 'version-multiline-error') { console.log('\\x1b[31m' + JSON.stringify({debug_message:'invalid scope',message:'Bad Request',type:'bad_request'},null,2) + '\\x1b[0m'); console.log('Script footer'); process.exit(0); }
  if (mode === 'version-multiline' || mode === 'version-multiline-array') {
    const value = {snap_in_version:{id:${JSON.stringify(versionId)},manifest:'quoted "value" and braces { inside text }'}};
    console.log(JSON.stringify(mode.endsWith('array') ? [value] : value,null,2)); console.log('Script footer'); process.exit(0);
  }
  if (mode === 'version-json-zero') { console.log('\\x1b[31m' + JSON.stringify({debug_message:'following scopes do not exist: [comment:write]',message:'Bad Request',type:'bad_request'}) + '\\x1b[0m'); process.exit(0); }
  if (mode === 'version-nonzero') { console.error('version creation failed'); process.exit(7); }
  if (mode === 'version-missing-id') { console.log('{}'); process.exit(0); }
  if (mode.startsWith('recover-')) { console.log('terminal progress: ' + JSON.stringify({snap_in_version:{id:${JSON.stringify(versionId)}}})); process.exit(0); }
  if (mode === 'long-json') { console.log(JSON.stringify({snap_in_version:{id:${JSON.stringify(versionId)},state:'draft',manifest:('version: "2"\\ntext: alert’s affected entities\\n').repeat(500)}})); process.exit(0); }
  console.log(JSON.stringify({snap_in_version:{id:${JSON.stringify(versionId)}}})); process.exit(0);
}
if (command === 'snap_in_version list') {
  if (mode === 'recover-error') { console.log(JSON.stringify({message:'access denied',type:'forbidden'})); process.exit(0); }
  if (mode === 'recover-nonzero') { console.error('query failed'); process.exit(4); }
  const version = {id:${JSON.stringify(versionId)}};
  if (mode === 'recover-delayed') {
    const counter = process.env.DEPLOY_TEST_LOG + '.counter';
    const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter,'utf8')) : 0;
    fs.writeFileSync(counter,String(count+1));
    if (!count) { console.log('[]'); process.exit(0); }
  }
  if (mode === 'recover-raw' || mode === 'recover-delayed') { console.log(JSON.stringify(version)); process.exit(0); }
  if (mode === 'recover-wrapped') { console.log(JSON.stringify({snap_in_versions:[version]})); process.exit(0); }
  if (mode === 'recover-array') { console.log(JSON.stringify([version])); process.exit(0); }
  if (mode === 'recover-jsonl') { console.log(JSON.stringify(version)); console.log(JSON.stringify(version)); process.exit(0); }
  if (mode === 'recover-ambiguous') { console.log(JSON.stringify([version,{id:${JSON.stringify(packageId + ':snap_in_version/other')}}])); process.exit(0); }
  if (mode === 'recover-wrong-package') { console.log(JSON.stringify({id:'don:integration:example:devo/other:snap_in_package/unrelated:snap_in_version/unrelated'})); process.exit(0); }
  console.log('[]'); process.exit(0);
}
if (command === 'snap_in_version show') {
  if (mode === 'show-multiline-error') { console.log('Status logs'); console.log(JSON.stringify({message:'read denied',type:'forbidden'},null,2)); console.log('End logs'); process.exit(0); }
  if (mode === 'show-error') { console.log(JSON.stringify({message:'read denied',type:'forbidden'})); process.exit(0); }
  if (mode === 'build-failed') { console.log(JSON.stringify({snap_in_version:{state:'build_failed',failure_reason:'test build failed'}})); process.exit(0); }
  console.log(JSON.stringify({snap_in_version:{state:'ready'}})); process.exit(0);
}
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

test.each(['version-json-zero', 'version-nonzero', 'version-missing-id', 'version-multiline-error'])('fails %s and preserves the package for inspection', (mode) => {
  const result = run(mode);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain(mode === 'version-missing-id' ? 'Failed to get a unique version ID' : 'Failed to create snap-in version');
  expect(result.calls.some((args) => args[1] === 'delete-one')).toBe(false);
  expect(result.stdout).toContain('Package retained for inspection');
  expect(result.calls.some((args) => args[1] === 'draft' || args[1] === 'activate')).toBe(false);
  expect(result.stdout).not.toContain('Lambda deployment complete');
  if (mode === 'version-json-zero') expect(result.stdout).toContain('following scopes do not exist');
});

test.each(['recover-raw', 'recover-wrapped', 'recover-array', 'recover-jsonl', 'recover-delayed'])('recovers the version from its new package after terminal parsing fails (%s)', (mode) => {
  const result = run(mode);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Recovered version ID from the package');
  const queries = result.calls.filter((args) => args[0] === 'snap_in_version' && args[1] === 'list');
  expect(queries.length).toBe(mode === 'recover-delayed' ? 2 : 1);
  for (const query of queries) expect(query).toEqual(['snap_in_version', 'list', '--package', packageId, '--all', '--org', 'test-org', '--usr', 'developer@example.com']);
  expect(result.calls).toContainEqual(['snap_in', 'draft', '--snap_in_version', versionId]);
  expect(result.calls.some((args) => args[1] === 'delete-one')).toBe(false);
});

test.each(['recover-error', 'recover-nonzero', 'recover-ambiguous', 'recover-wrong-package'])('does not guess a version or delete the package when recovery fails (%s)', (mode) => {
  const result = run(mode);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('Package retained for inspection');
  expect(result.calls.some((args) => args[1] === 'draft' || args[1] === 'activate' || args[1] === 'delete-one')).toBe(false);
});

test.each(['show-error', 'build-failed', 'show-multiline-error'])('preserves the existing version and package after %s', (mode) => {
  const result = run(mode);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('Package retained for inspection');
  expect(result.calls.some((args) => args[1] === 'delete-one' || args[1] === 'draft')).toBe(false);
});

test('reads a long create response with an escaped manifest and Unicode, without recovery', () => {
  const result = run('long-json');
  expect(result.status).toBe(0);
  expect(result.calls.some((args) => args[0] === 'snap_in_version' && args[1] === 'list')).toBe(false);
  expect(result.stdout).toContain('Lambda deployment complete');
});

test.each(['version-multiline', 'version-multiline-array'])('parses complete multiline JSON surrounded by logs without version recovery (%s)', (mode) => {
  const result = run(mode);
  expect(result.status).toBe(0);
  expect(result.calls.some((args) => args[0] === 'snap_in_version' && args[1] === 'list')).toBe(false);
  expect(result.calls).toContainEqual(['snap_in', 'draft', '--snap_in_version', versionId]);
  expect(result.stdout).toContain('Lambda deployment complete');
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
