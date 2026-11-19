import axios from 'axios';
import { client } from '@devrev/typescript-sdk';

import run from '../src/functions/fetch_newrelic_context';
import { HttpClient } from '../src/functions/external-system/http-client';
import { issuePermalink } from '../src/functions/external-system/links';

jest.mock('axios');
jest.mock('@devrev/typescript-sdk', () => ({
  ...jest.requireActual('@devrev/typescript-sdk'), client: { setup: jest.fn(), setupBeta: jest.fn() },
}));

const now = Date.parse('2026-11-19T12:00:00Z');
const sourceId = 'f0846f5e-fc9d-4dc0-afdd-07cce7cc6fc4';
const workId = 'don:core:dvrv-us-1:devo/test:issue/1';
const createdAt = now - 3600000;
const sourceIssue = { issueId: sourceId, title: ['Errors'], state: 'ACTIVATED', priority: 'CRITICAL', createdAt, updatedAt: now };
const post = jest.fn();
const worksGet = jest.fn();
const timelineEntriesCreate = jest.fn();
const timelineEntriesList = jest.fn();
const read = (fields: object = {}) => ({ data: { data: { actor: { account: { aiIssues: { issues: { issues: [{ ...sourceIssue, ...fields }] } } } } } } });
const mutation = (fields: object = {}) => ({ data: { data: { aiIssuesAckIssue: { error: null,
  result: { action: 'ACK', accountId: 123, issueId: sourceId }, ...fields } } } });
const api = (region = 'US') => new HttpClient({ org_id: region, key: 'private-nr-key' });
function click(region: 'US' | 'EU' = 'US') {
  return {
    payload: { action: { id: 'fetch_newrelic_context', value: 'acknowledge' }, context: { object_id: workId }, request_id: 'ack-click' },
    context: { snap_in_id: 'snap-1', secrets: { actor_session_token: 'actor-token' } },
    execution_metadata: { devrev_endpoint: 'https://api.devrev.ai' },
    input_data: { keyrings: { newrelic_context: 'private-nr-key' } },
  };
}
function work(region: 'US' | 'EU' = 'US') {
  return { id: workId, type: 'issue', created_date: new Date(createdAt).toISOString(),
    sync_metadata: { external_record_id: '123:' + sourceId, external_reference: issuePermalink('123', sourceId, region) } };
}
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  (axios.create as jest.Mock).mockReturnValue({ post });
  (axios.isAxiosError as unknown as jest.Mock).mockImplementation((error) => error?.isAxiosError === true);
  (client.setup as jest.Mock).mockReturnValue({ worksGet, timelineEntriesCreate, timelineEntriesList });
  worksGet.mockResolvedValue({ data: { work: work() } });
  timelineEntriesCreate.mockResolvedValue({ data: {} });
  post.mockResolvedValueOnce(read()).mockResolvedValueOnce(mutation()).mockResolvedValueOnce(read({ acknowledgedAt: now }));
});
afterEach(() => jest.restoreAllMocks());

test.each(['US', 'EU'])('acknowledges using the existing %s user key and verifies read-back', async (region) => {
  await expect(api(region).acknowledgeIssue('123', sourceId, createdAt)).resolves.toBe('acknowledged');
  expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
    baseURL: region === 'EU' ? 'https://api.eu.newrelic.com/graphql' : 'https://api.newrelic.com/graphql',
    headers: expect.objectContaining({ 'API-Key': 'private-nr-key', 'nerd-graph-unsafe-experimental-opt-in': 'AiIssues' }),
  }));
  expect(post).toHaveBeenCalledTimes(3);
  expect(post.mock.calls[0][1].query).toContain('acknowledgedAt');
  expect(post.mock.calls[1][1]).toEqual({ query: expect.stringContaining('aiIssuesAckIssue(accountId: $accountId, issueId: "' + sourceId + '")'), variables: { accountId: 123 } });
  expect(post.mock.calls[1][1].query).not.toMatch(/Resolve|Unack|nrql/);
  expect(post.mock.calls[2][1]).toEqual(post.mock.calls[0][1]);
});

test.each([
  [{ acknowledgedAt: now }, 'already_acknowledged'],
  [{ state: 'CLOSED', acknowledgedAt: now }, 'closed'],
])('does not mutate a source that is already handled (%j)', async (fields, outcome) => {
  post.mockReset().mockResolvedValue(read(fields as object));
  await expect(api().acknowledgeIssue('123', sourceId, createdAt)).resolves.toBe(outcome);
  expect(post).toHaveBeenCalledTimes(1);
});

test.each(['source-issue', sourceId + '") { injected }', '', 'https://attacker.example'])('rejects non-UUID write targets %j before network access', async (id) => {
  await expect(api().acknowledgeIssue('123', id, createdAt)).rejects.toMatchObject({ code: 'rejected' });
  expect(post).not.toHaveBeenCalled();
});

test.each(['0', '-1', '2147483648', '123) { injected }'])('rejects invalid mutation account %j', async (account) => {
  await expect(api().acknowledgeIssue(account, sourceId, createdAt)).rejects.toThrow();
  expect(post).not.toHaveBeenCalled();
});

test('does not write an unrecognized issue state', async () => {
  post.mockReset().mockResolvedValue(read({ state: 'UNKNOWN', acknowledgedAt: null }));
  await expect(api().acknowledgeIssue('123', sourceId, createdAt)).rejects.toMatchObject({ code: 'rejected' });
  expect(post).toHaveBeenCalledTimes(1);
});

test.each(['private-nr-key actor-token', { reason: 'private-nr-key' }, '', false])('does not treat HTTP success with mutation error %j as acknowledgment', async (error) => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce(mutation({ error }));
  await expect(api().acknowledgeIssue('123', sourceId, createdAt)).rejects.toMatchObject({ code: 'rejected' });
  expect(post).toHaveBeenCalledTimes(2);
});

test.each([
  { result: { action: 'RESOLVE', accountId: 123, issueId: sourceId } },
  { result: { action: 'ACK', accountId: 999, issueId: sourceId } },
  { result: { action: 'ACK', accountId: 123, issueId: 'other' } },
  { result: null }, { error: undefined },
])('requires an exact mutation receipt (%j)', async (fields) => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce(mutation(fields));
  await expect(api().acknowledgeIssue('123', sourceId, createdAt)).rejects.toMatchObject({ code: 'unconfirmed' });
  expect(post).toHaveBeenCalledTimes(2);
});

test.each([null, 0, -1, '2026-11-19', undefined])('requires a positive acknowledgment timestamp on read-back (%j)', async (acknowledgedAt) => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce(mutation()).mockResolvedValueOnce(read({ acknowledgedAt }));
  await expect(api().acknowledgeIssue('123', sourceId, createdAt)).rejects.toMatchObject({ code: 'unconfirmed' });
  expect(post).toHaveBeenCalledTimes(3);
});

test('leaves a lost mutation response unconfirmed and checks the source on the next delivery', async () => {
  post.mockReset().mockResolvedValueOnce(read()).mockRejectedValueOnce({ isAxiosError: true,
    config: { headers: { 'API-Key': 'private-nr-key' } } }).mockResolvedValueOnce(read({ acknowledgedAt: now }));
  const http = api();
  await expect(http.acknowledgeIssue('123', sourceId, createdAt)).rejects.toMatchObject({ code: 'unconfirmed' });
  await expect(http.acknowledgeIssue('123', sourceId, createdAt)).resolves.toBe('already_acknowledged');
  expect(post.mock.calls.filter((call) => call[1].query.includes('mutation('))).toHaveLength(1);
});

test('requires read-back even after a valid mutation response', async () => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce(mutation()).mockRejectedValueOnce(new Error('private-nr-key'));
  await expect(api().acknowledgeIssue('123', sourceId, createdAt)).rejects.toMatchObject({ code: 'unconfirmed' });
});

test.each(['US', 'EU'] as const)('standalone action authorizes the selected issue and posts its verified %s result without an agent', async (region) => {
  worksGet.mockResolvedValue({ data: { work: work(region) } });
  await expect(run([click(region)])).resolves.toMatchObject({ status: 'success', acknowledgment_status: 'acknowledged' });
  expect(client.setup).toHaveBeenCalledWith({ endpoint: 'https://api.devrev.ai', token: 'actor-token' });
  expect(worksGet).toHaveBeenCalledWith({ id: workId }, { timeout: 10000 });
  expect(timelineEntriesCreate).toHaveBeenCalledWith(expect.objectContaining({
    object: workId, type: 'timeline_comment', visibility: 'internal', external_ref: expect.stringMatching(/^newrelic-acknowledgment:[a-f0-9]{64}$/),
    body: expect.stringContaining('acknowledgment was verified'),
  }), { timeout: 10000 });
  expect(post.mock.calls.some((call) => call[1].query.includes('nrql'))).toBe(false);
  expect(client.setupBeta).not.toHaveBeenCalled();
  expect(JSON.stringify(timelineEntriesCreate.mock.calls)).not.toMatch(/private-nr-key|actor-token/);
});

test.each(['no token', 'no issue access', 'wrong issue', 'source mismatch', 'wrong work type'])('never writes to New Relic when %s', async (failure) => {
  const input = click();
  if (failure === 'no token') input.context.secrets.actor_session_token = '';
  if (failure === 'no issue access') worksGet.mockRejectedValue(new Error('actor-token'));
  if (failure === 'wrong issue') worksGet.mockResolvedValue({ data: { work: { ...work(), id: workId + '2' } } });
  if (failure === 'wrong work type') worksGet.mockResolvedValue({ data: { work: { ...work(), type: 'ticket' } } });
  if (failure === 'source mismatch') worksGet.mockResolvedValue({ data: { work: { ...work(), sync_metadata: { ...work().sync_metadata, external_record_id: '999:other' } } } });
  await expect(run([input])).rejects.toThrow();
  expect(post).not.toHaveBeenCalled();
  expect(timelineEntriesCreate).not.toHaveBeenCalled();
});

test('reports rejected and uncertain acknowledgment without raw errors or tokens', async () => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce(mutation({ error: 'private-nr-key actor-token' }));
  await expect(run([click()])).resolves.toMatchObject({ acknowledgment_status: 'rejected', detail: expect.stringContaining('did not accept') });
  expect(timelineEntriesCreate.mock.calls[0][0].body).toContain('did not accept');
  expect(JSON.stringify(timelineEntriesCreate.mock.calls)).not.toMatch(/private-nr-key|actor-token/);
  expect(JSON.stringify((console.info as jest.Mock).mock.calls)).not.toMatch(/private-nr-key|actor-token/);
});

test('deduplicates a repeated click comment and avoids another mutation after acknowledgment', async () => {
  await run([click()]);
  const firstComment = timelineEntriesCreate.mock.calls[0][0];
  post.mockResolvedValue(read({ acknowledgedAt: now }));
  timelineEntriesCreate.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409 } });
  timelineEntriesList.mockResolvedValueOnce({ data: { timeline_entries: [firstComment] } });
  await expect(run([click()])).resolves.toMatchObject({ acknowledgment_status: 'already_acknowledged' });
  expect(timelineEntriesCreate.mock.calls[1][0].external_ref).toBe(firstComment.external_ref);
  expect(post.mock.calls.filter((call) => call[1].query.includes('mutation('))).toHaveLength(1);
  expect(console.error).not.toHaveBeenCalled();
});

test('returns an explicit warning if the result cannot be posted after the acknowledgment', async () => {
  timelineEntriesCreate.mockRejectedValue({ isAxiosError: true, response: { status: 403 }, config: { token: 'actor-token' } });
  await expect(run([click()])).resolves.toMatchObject({ acknowledgment_status: 'acknowledged', detail: expect.stringContaining('could not be posted') });
  expect(console.error).toHaveBeenCalledWith('[newrelic-context] acknowledgment:report_failed');
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(/private-nr-key|actor-token/);
});
