import { codingProvider, codingResult } from '../src/functions/fetch_newrelic_context/coding-policy';

const repository = 'harrykimpel/O11yParty-Buzzer';
const binding = { repository, provider: 'copilot', issue_number: 165, operation: 'start' as const };
const assigned = { status: 'assigned', provider: 'copilot', issue_number: 165, issue_url: `https://github.com/${repository}/issues/165` };
const pr = { ...assigned, status: 'pull_request', pr_number: 166, pr_url: `https://github.com/${repository}/pull/166`, pr_state: 'open', draft: true };

test('defaults to Copilot and fails closed for providers without an adapter', () => {
  expect(codingProvider(undefined)?.id).toBe('copilot');
  expect(codingProvider('')?.id).toBe('copilot');
  expect(codingProvider('Copilot')?.id).toBe('copilot');
  expect(codingProvider('other-agent')).toBeUndefined();
  expect(codingProvider('toString')).toBeUndefined();
  expect(codingProvider({})).toBeUndefined();
});

test('distinguishes an assignment from a verified PR and accepts formatted reports', () => {
  expect(codingResult(JSON.stringify(assigned), binding)).toContain('No linked PR was verified yet');
  expect(codingResult('Verified.\n```json\n' + JSON.stringify({ ...pr, pr_url: `[Pull request](<${pr.pr_url}>)` }) + '\n```', binding))
    .toContain(`[PR #166](<${pr.pr_url}>)`);
  expect(codingResult(JSON.stringify(pr), binding)).toContain('draft PR (open)');
  expect(codingResult(JSON.stringify({ ...pr, draft: false, pr_state: 'merged' }), binding)).toContain('PR (merged)');
  expect(codingResult(JSON.stringify({ ...pr, pr_state: 'closed' }), binding)).toContain('PR (closed)');
});

test('accepts not_started only for a read-only status check', () => {
  const message = JSON.stringify({ ...assigned, status: 'not_started' });
  expect(codingResult(message, binding)).toBeUndefined();
  expect(codingResult(message, { ...binding, operation: 'status' })).toContain('This check did not start a coding run');
});

test.each([
  { provider: 'other' }, { issue_number: 164 }, { issue_number: '165' },
  { issue_url: `https://github.com/${repository}/issues/164` },
  { pr_number: 167 }, { pr_number: '166' }, { draft: 'true' }, { pr_state: 'complete' },
  { pr_url: 'https://github.com/other/repo/pull/166' },
  { pr_url: `https://github.com/${repository}/issues/166` },
  { pr_url: `https://github.com/${repository}/pull/166?token=secret` },
  { pr_url: `https://github.com/${repository}/pull/166#discussion` },
  { pr_url: `https://user:password@github.com/${repository}/pull/166` },
  { pr_url: `https://github.com.evil.test/${repository}/pull/166` },
  { pr_url: `[https://github.com/${repository}/pull/166](https://evil.test/pull/166)` },
])('rejects mismatched or unsafe coding results: %j', (patch) => {
  expect(codingResult(JSON.stringify({ ...pr, ...patch }), binding)).toBeUndefined();
});

test.each([
  JSON.stringify(pr) + '\n' + JSON.stringify(assigned),
  JSON.stringify({ ...assigned, pr_url: pr.pr_url }),
  JSON.stringify({ ...assigned, status: 'error' }),
  'Created PR: ' + pr.pr_url,
])('rejects ambiguous, failed or unstructured reports (case %#)', (message) => {
  expect(codingResult(message, binding)).toBeUndefined();
});
