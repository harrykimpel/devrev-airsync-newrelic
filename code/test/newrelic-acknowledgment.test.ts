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
const nativeSetTimeout = global.setTimeout;
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
  // Exercise the real retry loop without spending wall time on backoff.
  jest.spyOn(global, 'setTimeout').mockImplementation((callback) => nativeSetTimeout(callback, 0));
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
  [{ result: { action: 'RESOLVE', accountId: 123, issueId: sourceId } }, 'receipt_action_mismatch'],
  [{ result: { action: 'ACK', accountId: 999, issueId: sourceId } }, 'receipt_account_mismatch'],
  [{ result: { action: 'ACK', accountId: 123, issueId: 'other' } }, 'receipt_issue_mismatch'],
  [{ result: null }, 'receipt_missing'], [{ error: undefined }, 'receipt_error_missing'],
])('does not trust an inexact mutation receipt without source confirmation (%j)', async (fields, diagnostic) => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce(mutation(fields)).mockResolvedValue(read({ acknowledgedAt: null }));
  await expect(api().acknowledgeIssue('123', sourceId, createdAt)).rejects.toMatchObject({ code: 'unconfirmed', diagnostic });
  expect(post).toHaveBeenCalledTimes(5);
});

test.each([null, 0, -1, '2026-11-19', undefined, true, {}, [], '9007199254740993', ' 1795089600000', '1e12'])('does not reconcile an uncertain receipt using an invalid timestamp (%j)', async (acknowledgedAt) => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce(mutation({ result: null })).mockResolvedValue(read({ acknowledgedAt }));
  await expect(api().acknowledgeIssue('123', sourceId, createdAt)).rejects.toMatchObject({ code: 'unconfirmed', diagnostic: 'receipt_missing' });
  expect(post).toHaveBeenCalledTimes(5);
});

test('reconciles a lost mutation response from the exact source without repeating the mutation', async () => {
  post.mockReset().mockResolvedValueOnce(read()).mockRejectedValueOnce({ isAxiosError: true,
    config: { headers: { 'API-Key': 'private-nr-key' } } }).mockResolvedValueOnce(read({ acknowledgedAt: now }));
  await expect(api().acknowledgeIssue('123', sourceId, createdAt)).resolves.toBe('acknowledged');
  expect(post.mock.calls.filter((call) => call[1].query.includes('mutation('))).toHaveLength(1);
  expect(console.info).toHaveBeenCalledWith('[newrelic-context] acknowledgment:reconciled code=mutation_request_failed');
});

test('can confirm a write from source state when the mutation receipt is unexpected', async () => {
  post.mockReset().mockResolvedValueOnce(read())
    .mockResolvedValueOnce(mutation({ result: { action: 'UNKNOWN', accountId: 999, issueId: 'other' } }))
    .mockResolvedValueOnce(read({ acknowledgedAt: now }));
  await expect(run([click()])).resolves.toMatchObject({ acknowledgment_status: 'acknowledged' });
  expect(post.mock.calls.filter((call) => call[1].query.includes('mutation('))).toHaveLength(1);
  expect(post.mock.calls[2][1].query).toContain('ids: ["' + sourceId + '"]');
  expect(post.mock.calls[2][1].variables.accountId).toBe(123);
  expect(console.info).toHaveBeenCalledWith('[newrelic-context] acknowledgment:reconciled code=receipt_action_mismatch');
  expect(timelineEntriesCreate.mock.calls[0][0].body).toContain('acknowledgment was verified');
});

test('an uncertain mutation remains unconfirmed if only a different source issue is acknowledged', async () => {
  const wrong = read({ issueId: 'different-source', acknowledgedAt: now });
  post.mockReset().mockResolvedValueOnce(read()).mockRejectedValueOnce(new Error('private-nr-key')).mockResolvedValue(wrong);
  await expect(api().acknowledgeIssue('123', sourceId, createdAt)).rejects.toMatchObject({ code: 'unconfirmed', diagnostic: 'mutation_request_failed' });
  expect(post).toHaveBeenCalledTimes(5);
});

test('a later delivery reads the source first when a previous write and all its checks were uncertain', async () => {
  post.mockReset().mockResolvedValueOnce(read()).mockRejectedValueOnce(new Error('private-nr-key'))
    .mockResolvedValueOnce(read()).mockResolvedValueOnce(read()).mockResolvedValueOnce(read())
    .mockResolvedValueOnce(read({ acknowledgedAt: now }));
  const http = api();
  await expect(http.acknowledgeIssue('123', sourceId, createdAt)).rejects.toMatchObject({ code: 'unconfirmed', diagnostic: 'mutation_request_failed' });
  await expect(http.acknowledgeIssue('123', sourceId, createdAt)).resolves.toBe('already_acknowledged');
  expect(post.mock.calls.filter((call) => call[1].query.includes('mutation('))).toHaveLength(1);
});

test('keeps a valid ACK request confirmed by the API when subsequent queries fail', async () => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce(mutation()).mockRejectedValue(new Error('private-nr-key'));
  await expect(api().acknowledgeIssue('123', sourceId, createdAt)).resolves.toBe('acknowledged_by_api');
  expect(console.info).toHaveBeenCalledWith('[newrelic-context] acknowledgment:api_confirmed code=read_back_failed');
  expect(post).toHaveBeenCalledTimes(5);
});

test('verifies a delayed acknowledgment with bounded read retries and a single mutation', async () => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce(mutation())
    .mockResolvedValueOnce(read({ acknowledgedAt: null })).mockResolvedValueOnce(read({ acknowledgedAt: null }))
    .mockResolvedValueOnce(read({ acknowledgedAt: now }));
  await expect(api().acknowledgeIssue('123', sourceId, createdAt)).resolves.toBe('acknowledged');
  expect(post).toHaveBeenCalledTimes(5);
  expect(post.mock.calls.filter((call) => call[1].query.includes('mutation('))).toHaveLength(1);
  expect((global.setTimeout as unknown as jest.Mock).mock.calls.map((call) => call[1])).toEqual([500, 1500]);
});

test('can verify after a transient read-back request failure', async () => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce(mutation())
    .mockRejectedValueOnce({ isAxiosError: true, config: { headers: { 'API-Key': 'private-nr-key' } } })
    .mockResolvedValueOnce(read({ acknowledgedAt: now }));
  await expect(api().acknowledgeIssue('123', sourceId, createdAt)).resolves.toBe('acknowledged');
  expect(post).toHaveBeenCalledTimes(4);
});

test.each(['before', 'after'])('accepts a canonical decimal epoch string %s the mutation without unsafe coercion', async (when) => {
  post.mockReset();
  if (when === 'before') post.mockResolvedValue(read({ acknowledgedAt: String(now) }));
  else post.mockResolvedValueOnce(read()).mockResolvedValueOnce(mutation()).mockResolvedValue(read({ acknowledgedAt: String(now) }));
  await expect(api().acknowledgeIssue('123', sourceId, createdAt)).resolves.toBe(when === 'before' ? 'already_acknowledged' : 'acknowledged');
  expect(post).toHaveBeenCalledTimes(when === 'before' ? 1 : 3);
});

test('does not conflate an unreadable source before writing with an uncertain mutation', async () => {
  post.mockReset().mockRejectedValue(new Error('private-nr-key'));
  await expect(run([click()])).resolves.toMatchObject({ acknowledgment_status: 'unconfirmed', detail: expect.stringContaining('No acknowledgment was sent') });
  expect(post).toHaveBeenCalledTimes(1);
  expect(console.info).toHaveBeenCalledWith('[newrelic-context] acknowledgment:diagnostic code=source_read_failed');
  expect(timelineEntriesCreate.mock.calls[0][0].body).toContain('Diagnostic: source_read_failed');
  expect(JSON.stringify(timelineEntriesCreate.mock.calls)).not.toContain('private-nr-key');
});

test('reports the exact successful ACK response as API-confirmed without claiming verified query state', async () => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce(mutation()).mockResolvedValue(read({ acknowledgedAt: null }));
  await expect(run([click()])).resolves.toMatchObject({ acknowledgment_status: 'acknowledged_by_api', detail: expect.stringContaining('New Relic confirmed the acknowledgment request') });
  expect(console.info).toHaveBeenCalledWith('[newrelic-context] acknowledgment:api_confirmed code=read_back_pending');
  const body = timelineEntriesCreate.mock.calls[0][0].body;
  expect(body).toContain('follow-up state check was inconclusive');
  expect(body).not.toMatch(/Diagnostic:|connection permissions|verified by reading|could not be confirmed/);
  expect(post.mock.calls.filter((call) => call[1].query.includes('mutation('))).toHaveLength(1);
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

const investigated = (fields: object = {}) => ({ data: { data: { aiIssuesMarkAsInvestigating: { error: null,
  result: { action: 'MARK_AS_INVESTIGATING', accountId: 123, issueId: sourceId }, ...fields } } } });

test.each(['US', 'EU'])('uses the captured investigating operation and verifies the exact %s source', async (region) => {
  post.mockReset().mockResolvedValueOnce(read({ acknowledgedAt: now, investigatedAt: null }))
    .mockResolvedValueOnce(investigated()).mockResolvedValueOnce(read({ investigatedAt: now }));
  await expect(api(region).markIssueInvestigating('123', sourceId, createdAt)).resolves.toBe('investigating');
  expect(post.mock.calls[1][1]).toEqual({ query: expect.stringContaining('aiIssuesMarkAsInvestigating(accountId: $accountId, issueId: $issueId)'),
    variables: { accountId: 123, issueId: sourceId } });
  expect(post.mock.calls[1][1].query).toContain('$issueId: ID!');
  expect(post.mock.calls[0][1].query).toContain('investigatedAt');
  expect(post.mock.calls[2][1].query).toContain('ids: ["' + sourceId + '"]');
  expect(post).toHaveBeenCalledTimes(3);
  expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({ baseURL: region === 'EU' ? 'https://api.eu.newrelic.com/graphql' : 'https://api.newrelic.com/graphql' }));
});

test.each([
  [{ investigatedAt: now }, 'already_investigating'],
  [{ investigatedAt: String(now) }, 'already_investigating'],
  [{ state: 'CLOSED', investigatedAt: null }, 'closed'],
])('skips the investigation mutation for source state %j', async (fields, status) => {
  post.mockReset().mockResolvedValue(read(fields as object));
  await expect(api().markIssueInvestigating('123', sourceId, createdAt)).resolves.toBe(status);
  expect(post).toHaveBeenCalledTimes(1);
});

test('retries investigation verification reads without repeating the mutation', async () => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce(investigated())
    .mockResolvedValueOnce(read({ investigatedAt: null })).mockResolvedValueOnce(read({ investigatedAt: String(now) }));
  await expect(api().markIssueInvestigating('123', sourceId, createdAt)).resolves.toBe('investigating');
  expect(post).toHaveBeenCalledTimes(4);
  expect(post.mock.calls.filter((call) => call[1].query.includes('mutation '))).toHaveLength(1);
});

test('reconciles an uncertain investigation response using only the intended source', async () => {
  post.mockReset().mockResolvedValueOnce(read()).mockRejectedValueOnce(new Error('private-nr-key'))
    .mockResolvedValueOnce(read({ investigatedAt: now }));
  await expect(api().markIssueInvestigating('123', sourceId, createdAt)).resolves.toBe('investigating');
  expect(post).toHaveBeenCalledTimes(3);
});

test('never trusts an investigation response when read-back contains only another source issue', async () => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce(investigated())
    .mockResolvedValue(read({ issueId: 'another-source', investigatedAt: now }));
  await expect(api().markIssueInvestigating('123', sourceId, createdAt)).rejects.toMatchObject({ code: 'read_back_pending' });
  expect(post).toHaveBeenCalledTimes(5);
});

test('does not report investigation success for an explicit mutation error', async () => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce(investigated({ error: 'private-nr-key' }));
  await expect(api().markIssueInvestigating('123', sourceId, createdAt)).rejects.toMatchObject({ code: 'mutation_rejected' });
  expect(post).toHaveBeenCalledTimes(2);
});

test.each(['source-issue', 'bad") { injection }'])('rejects invalid investigation UUID %s before any request', async (id) => {
  await expect(api().markIssueInvestigating('123', id, createdAt)).rejects.toMatchObject({ code: 'invalid_source' });
  expect(post).not.toHaveBeenCalled();
});

test('bounds investigation confirmation when an empty response does not lead to a verified source update', async () => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce({ data: { data: {} } }).mockResolvedValue(read({ investigatedAt: null }));
  await expect(api().markIssueInvestigating('123', sourceId, createdAt)).rejects.toMatchObject({ code: 'mutation_unconfirmed' });
  expect(post).toHaveBeenCalledTimes(5);
});

test.each([
  [{ message: 'Cannot query field "aiIssuesMarkAsInvestigating" on type "RootMutationType". private-nr-key' }, 'operation_unavailable'],
  [{ message: 'Variable "$issueId" of type "ID!" used in position expecting type "String!". private-nr-key' }, 'validation_error'],
  [{ extensions: { errorClass: 'ACCESS_DENIED' }, message: 'private-nr-key' }, 'access_denied'],
  [{ extensions: { errorClass: 'GRAPHQL_VALIDATION_FAILED' }, message: 'private-nr-key' }, 'validation_error'],
  [{ extensions: { errorClass: 'THROTTLED' }, message: 'private-nr-key' }, 'throttled'],
  [{ extensions: { errorClass: 'private-nr-key' }, message: 'private-nr-key' }, 'graphql_error'],
])('retains only safe investigation diagnostics from GraphQL errors (%j)', async (error, reason) => {
  post.mockReset().mockResolvedValueOnce(read()).mockResolvedValueOnce({ data: { errors: [error] } }).mockResolvedValue(read());
  const failure = await api().markIssueInvestigating('123', sourceId, createdAt).catch((error) => error);
  expect(failure).toMatchObject({ code: 'mutation_unconfirmed', reason });
  expect(String(failure) + JSON.stringify(failure)).not.toContain('private-nr-key');
  expect(post.mock.calls.filter((call) => call[1].query.includes('mutation '))).toHaveLength(1);
});

test.each([400, 401, 403, 429, 503])('retains HTTP %s without credentials when an investigation mutation fails', async (status) => {
  post.mockReset().mockResolvedValueOnce(read()).mockRejectedValueOnce({ isAxiosError: true,
    response: { status, data: 'private-nr-key' }, config: { headers: { 'API-Key': 'private-nr-key' } },
  }).mockResolvedValue(read());
  const failure = await api().markIssueInvestigating('123', sourceId, createdAt).catch((error) => error);
  expect(failure).toMatchObject({ code: 'mutation_unconfirmed', reason: 'http_error', httpStatus: status });
  expect(String(failure) + JSON.stringify(failure)).not.toContain('private-nr-key');
  expect(post).toHaveBeenCalledTimes(5);
});

test('distinguishes network errors, empty responses and unexpected response envelopes', async () => {
  const cases = [
    { response: { isAxiosError: true, config: { headers: { 'API-Key': 'private-nr-key' } } }, reason: 'network_error', rejected: true },
    { response: { data: {} }, reason: 'empty_response' },
    { response: { data: { data: {} } }, reason: 'unexpected_response' },
    { response: { data: { data: {}, errors: 'private-nr-key' } }, reason: 'unexpected_response' },
    { response: { data: { data: {}, errors: [null] } }, reason: 'unexpected_response' },
  ];
  for (const scenario of cases) {
    post.mockReset().mockResolvedValueOnce(read());
    if (scenario.rejected) post.mockRejectedValueOnce(scenario.response);
    else post.mockResolvedValueOnce(scenario.response);
    post.mockResolvedValue(read());
    const failure = await api().markIssueInvestigating('123', sourceId, createdAt).catch((error) => error);
    expect(failure).toMatchObject({ code: 'mutation_unconfirmed', reason: scenario.reason });
    expect(String(failure) + JSON.stringify(failure)).not.toContain('private-nr-key');
  }
});

test('retains the source-read failure reason without sending an investigation mutation', async () => {
  post.mockReset().mockResolvedValue({ data: { errors: [{ extensions: { errorClass: 'ACCESS_DENIED' }, message: 'private-nr-key' }] } });
  await expect(api().markIssueInvestigating('123', sourceId, createdAt)).rejects.toMatchObject({ code: 'source_read_failed', reason: 'access_denied' });
  expect(post).toHaveBeenCalledTimes(1);
});
