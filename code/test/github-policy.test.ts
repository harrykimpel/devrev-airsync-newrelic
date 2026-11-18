import { readFileSync } from 'fs';
import { join } from 'path';

import { githubResult } from '../src/functions/fetch_newrelic_context/github-policy';

const repository = 'harrykimpel/O11yParty-Buzzer';
const url = 'https://github.com/' + repository + '/issues/165';
const report = { status: 'created', url, issue_number: 165 };
const reply = readFileSync(join(__dirname, 'fixtures/github-agent-reply.txt'), 'utf8');

test('accepts the actual verified issue reply with introductory prose and a Markdown URL field', () => {
  expect(githubResult(reply, repository)).toBe('## GitHub issue from New Relic analysis\n\nAgent reported: created [GitHub issue #165](<' + url + '>).');
});

test.each([
  'Issue verified.\n\n' + JSON.stringify(report),
  'Issue verified.\n```json\n' + JSON.stringify(report) + '\n```\nComplete.',
  JSON.stringify({ ...report, url: '[GitHub issue](<' + url + '>)' }),
  JSON.stringify({ ...report, url: '<' + url + '>' }),
  'Verified: ' + JSON.stringify({ ...report, note: 'Braces {inside} a string, a quote " and a backslash \\ do not end the object.' }),
])('accepts formatting around one unambiguous report: %s', (message) => {
  expect(githubResult(message, repository)).toContain('[GitHub issue #165](<' + url + '>)');
});

test.each([
  JSON.stringify({ ...report, url: '[' + url + '](https://evil.test/issues/165)' }),
  JSON.stringify({ ...report, url: '[Issue](https://github.com/other/repo/issues/165)' }),
  JSON.stringify({ ...report, url: '[Issue](https://github.com/' + repository + '/pull/165)' }),
  JSON.stringify({ ...report, url: '[Issue](https://user:pass@github.com/' + repository + '/issues/165)' }),
  JSON.stringify({ ...report, url: '[Issue](' + url + '?token=secret)' }),
  JSON.stringify({ ...report, url: '[Issue](https://github.com.evil.test/' + repository + '/issues/165)' }),
])('validates a Markdown link destination rather than trusting its label: %s', (message) => {
  expect(githubResult(message, repository)).toBeUndefined();
});

test.each([
  '```json\n[' + JSON.stringify(report) + ']\n```',
  'Result: [\n' + JSON.stringify(report) + '\n]',
  'Result: [\n' + JSON.stringify(report),
  '```json\n[' + JSON.stringify(report) + '\n```',
  JSON.stringify(report) + '\n[',
  '{"status":"error"}\n' + JSON.stringify(report),
  JSON.stringify(report) + '\n{"status":"error"}',
  JSON.stringify(report) + '\n' + JSON.stringify({ ...report, url: url.replace('165', '166'), issue_number: 166 }),
  JSON.stringify(report) + '\n{"another":"object"}',
  JSON.stringify(report) + '\n{"incomplete":',
])('rejects multiple or incomplete reports instead of selecting a success: %s', (message) => {
  expect(githubResult(message, repository)).toBeUndefined();
});

test.each([
  'Created issue: ' + url,
  JSON.stringify({ status: 'error', url, issue_number: 165 }),
  JSON.stringify({ ...report, status: ['created'] }),
  JSON.stringify({ ...report, issue_number: '165' }),
  JSON.stringify({ ...report, issue_number: 166 }),
  JSON.stringify([report]),
  JSON.stringify(JSON.stringify(report)),
  'Prefix {"nested":' + JSON.stringify(report),
  'x'.repeat(32768) + JSON.stringify(report),
])('retains the structured status/number requirements and bounded parsing (case %#)', (message) => {
  expect(githubResult(message, repository)).toBeUndefined();
});
