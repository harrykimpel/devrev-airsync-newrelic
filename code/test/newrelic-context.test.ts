import axios from 'axios';
import { client } from '@devrev/typescript-sdk';

import run from '../src/functions/fetch_newrelic_context';
import { planContext, redact, renderContext, traceSpansQuery } from '../src/functions/fetch_newrelic_context/context';
import { issuePermalink, parseIssueReference } from '../src/functions/external-system/links';
import { HttpClient } from '../src/functions/external-system/http-client';

jest.mock('axios');
jest.mock('@devrev/typescript-sdk', () => ({
  ...jest.requireActual('@devrev/typescript-sdk'),
  client: { setup: jest.fn(), setupBeta: jest.fn() },
}));

const now = Date.parse('2026-11-17T12:00:00Z');
const issue = { issueId: 'source-issue', title: ['Latency'], state: 'ACTIVATED', priority: 'CRITICAL', createdAt: now - 3600000, updatedAt: now, entityGuids: ['YWJj', 'ZGVm'] };
const post = jest.fn();
const worksGet = jest.fn();
const timelineEntriesCreate = jest.fn();
const timelineEntriesList = jest.fn();
const snapInsResources = jest.fn();
function event(region: 'US' | 'EU' = 'US') {
  return {
    payload: { action: { id: 'fetch_newrelic_context', value: 'alert' }, context: { object_id: 'ISS-1' }, request_id: 'click-1' },
    context: { snap_in_id: 'snap-1', secrets: { actor_session_token: 'actor-token', service_account_token: 'bot-token' } },
    execution_metadata: { devrev_endpoint: 'https://api.devrev.ai' },
    input_data: { keyrings: { newrelic_context: 'private-nr-key' } },
  };
}
const sourceWork = (region: 'US' | 'EU' = 'US') => ({ id: 'ISS-1', type: 'issue', created_date: new Date(issue.createdAt).toISOString(), sync_metadata: { external_reference: issuePermalink('123', issue.issueId, region), external_record_id: '123:source-issue' } });
const graph = (data: object) => ({ data: { data: { actor: { account: data } } } });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(Date, 'now').mockReturnValue(now);
  (axios.create as jest.Mock).mockReturnValue({ post });
  (axios.isAxiosError as unknown as jest.Mock).mockImplementation((e) => e?.isAxiosError === true);
  (client.setup as jest.Mock).mockReturnValue({ worksGet, timelineEntriesCreate, timelineEntriesList });
  (client.setupBeta as jest.Mock).mockReturnValue({ snapInsResources });
  snapInsResources.mockResolvedValue({ data: { keyrings: { newrelic_context: { id: 'keyring-1', is_expired: false, secret: 'private-nr-key' } } } });
  worksGet.mockResolvedValue({ data: { work: sourceWork() } });
  timelineEntriesCreate.mockResolvedValue({ data: {} });
  timelineEntriesList.mockImplementation(async () => ({ data: { timeline_entries: [{ type: 'timeline_comment', visibility: 'internal', external_ref: timelineEntriesCreate.mock.calls[0][0].external_ref }] } }));
  post.mockImplementation(async (_url, body) => body.query.includes('aiIssues')
    ? graph({ aiIssues: { issues: { issues: [issue] } } })
    : graph({ nrql: { results: [{ value: 42 }] } }));
});
afterEach(() => jest.restoreAllMocks());

test.each(['US', 'EU'] as const)('fetches scoped metrics, logs and trace samples and posts one internal comment in %s', async (region) => {
  worksGet.mockResolvedValue({ data: { work: sourceWork(region) } });
  await expect(run([event(region)])).resolves.toMatchObject({ status: 'success' });
  expect(console.info).toHaveBeenNthCalledWith(1, '[newrelic-context] fetch:start');
  expect(console.info).toHaveBeenLastCalledWith('[newrelic-context] fetch:complete');
  expect(JSON.stringify((console.info as jest.Mock).mock.calls)).not.toMatch(/private-nr-key|actor-token|bot-token/);
  expect(client.setup).toHaveBeenCalledWith({ endpoint: 'https://api.devrev.ai', token: 'actor-token' });
  expect(client.setupBeta).not.toHaveBeenCalled();
  expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({ baseURL: region === 'EU' ? 'https://api.eu.newrelic.com/graphql' : 'https://api.newrelic.com/graphql', maxRedirects: 0, timeout: 10000 }));
  expect(post).toHaveBeenCalledTimes(4);
  expect(post.mock.calls[0][1]).toMatchObject({ query: expect.stringContaining('ids: ["source-issue"]'), variables: { accountId: 123 } });
  const queries = post.mock.calls.slice(1).map((call) => call[1].variables.query);
  for (const q of queries) {
    expect(q).toContain("WHERE entity.guid IN ('YWJj', 'ZGVm')");
    expect(q).toContain(`SINCE ${issue.createdAt - 900000} UNTIL ${issue.createdAt + 900000}`);
    expect(q).toMatch(/LIMIT (5|10)$/);
    expect(q).not.toContain('SELECT *');
  }
  const comment = timelineEntriesCreate.mock.calls[0][0];
  expect(comment).toMatchObject({ object: 'ISS-1', type: 'timeline_comment', visibility: 'internal', external_ref: expect.stringMatching(/^newrelic-context:[a-f0-9]{64}$/) });
  expect(comment.body).toContain('APM metrics');
  expect(comment.body).toContain('Recent error/warning logs');
  expect(comment.body).toContain('Trace samples');
  expect(comment.body).not.toMatch(/private-nr-key|actor-token|bot-token/);
});

test('supports historical broken links so existing imports can fetch context before re-sync', async () => {
  worksGet.mockResolvedValue({ data: { work: { ...sourceWork(), sync_metadata: { external_reference: 'https://one.newrelic.com/redirect/issue/source-issue?accountId=123' } } } });
  await run([event()]);
  expect(timelineEntriesCreate.mock.calls[0][0].body).toContain('/launcher/nrai.launcher?pane=');
});

test('latest window uses now rather than alert creation time', async () => {
  const input = event(); input.payload.action.value = 'recent';
  await run([input]);
  expect(post.mock.calls[1][1].variables.query).toContain(`SINCE ${now - 1800000} UNTIL ${now}`);
});

test('keeps successful sections when a telemetry query fails without exposing raw errors', async () => {
  post.mockImplementation(async (_url, body) => {
    if (body.query.includes('aiIssues')) return graph({ aiIssues: { issues: { issues: [issue] } } });
    if (body.variables.query.includes('FROM Log')) throw { isAxiosError: true, response: { status: 403, headers: {} }, config: { headers: { 'API-Key': 'private-nr-key' } } };
    return graph({ nrql: { results: [{ value: 99 }] } });
  });
  await run([event()]);
  const body = timelineEntriesCreate.mock.calls[0][0].body;
  expect(body).toContain('Unavailable: New Relic request failed (403)');
  expect(body).toContain('99');
  expect(body).not.toContain('private-nr-key');
});

test('does not broaden to account-wide telemetry when an alert lacks entity GUIDs', async () => {
  post.mockResolvedValue(graph({ aiIssues: { issues: { issues: [{ ...issue, entityGuids: [] }] } } }));
  await run([event()]);
  expect(post).toHaveBeenCalledTimes(1);
  expect(timelineEntriesCreate.mock.calls[0][0].body).toContain('No telemetry queried');
});

test('fetches actual sampled spans for returned trace IDs without removing entity/time limits', async () => {
  post.mockImplementation(async (_url, body) => {
    if (body.query.includes('aiIssues')) return graph({ aiIssues: { issues: { issues: [issue] } } });
    return graph({ nrql: { results: body.variables.query.includes('FACET trace.id') ? [{ facet: ['abc123'], slowestSpanSeconds: 2 }] : [{ id: 'span-1', duration: 2 }] } });
  });
  await run([event()]);
  expect(post).toHaveBeenCalledTimes(5);
  expect(post.mock.calls[4][1].variables.query).toContain("AND trace.id IN ('abc123')");
  expect(post.mock.calls[4][1].variables.query).toContain("WHERE entity.guid IN ('YWJj', 'ZGVm')");
  expect(timelineEntriesCreate.mock.calls[0][0].body).toContain('not complete traces');
  expect(timelineEntriesCreate.mock.calls[0][0].body).toContain('span-1');
});

test('does not interpolate invalid trace IDs into a follow-up query', () => {
  const plan = planContext(issue, 'recent', now);
  expect(traceSpansQuery(plan, [{ facet: "x') OR true --" }])).toBeUndefined();
  expect(traceSpansQuery(plan, [{ facet: 'abc123' }])?.query).toContain("trace.id IN ('abc123')");
});

test('supports resource-style keyring delivery', async () => {
  const input = event();
  const resourceInput = { ...input, input_data: { resources: { keyrings: { newrelic_context: { secret: 'private-nr-key' } } } } };
  await expect(run([resourceInput])).resolves.toMatchObject({ status: 'success' });
  expect(snapInsResources).not.toHaveBeenCalled();
});

test.each([undefined, {}, { keyrings: { newrelic_context: '' } }, { resources: { keyrings: {} } }])('loads the clicking user’s configured connection when the event omits its secret (%j)', async (inputData) => {
  const input = { ...event(), payload: { ...event().payload, actor_id: 'user-who-clicked' }, input_data: inputData };
  await expect(run([input])).resolves.toMatchObject({ status: 'success' });
  expect(client.setupBeta).toHaveBeenCalledWith({ endpoint: 'https://api.devrev.ai', token: 'bot-token' });
  expect(snapInsResources).toHaveBeenCalledWith({ id: 'snap-1', user: 'user-who-clicked' }, { timeout: 10000 });
  expect(client.setup).toHaveBeenCalledWith({ endpoint: 'https://api.devrev.ai', token: 'actor-token' });
  expect(worksGet).toHaveBeenCalledWith({ id: 'ISS-1' }, { timeout: 10000 });
  expect(timelineEntriesCreate).toHaveBeenCalledTimes(1);
  expect(console.info).toHaveBeenCalledWith('[newrelic-context] connection:lookup');
  expect(console.info).toHaveBeenCalledWith('[newrelic-context] connection:ready');
  expect(JSON.stringify((console.info as jest.Mock).mock.calls)).not.toMatch(/private-nr-key|actor-token|bot-token|user-who-clicked/);
});

test.each(['missing actor ID', 'missing service token', 'missing actor token'])('does not look up another user’s resources or substitute bot access when %s', async (failure) => {
  const input = { ...event(), payload: { ...event().payload, actor_id: 'user-who-clicked' }, input_data: {} };
  if (failure === 'missing actor ID') input.payload.actor_id = '';
  if (failure === 'missing service token') input.context.secrets.service_account_token = '';
  if (failure === 'missing actor token') input.context.secrets.actor_session_token = '';
  await expect(run([input])).rejects.toThrow();
  expect(snapInsResources).not.toHaveBeenCalled();
  expect(worksGet).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
  expect(timelineEntriesCreate).not.toHaveBeenCalled();
});

test.each(['missing', 'empty', 'expired', 'lookup denied'])('reports a safe connection failure for %s resources without reading the issue', async (failure) => {
  const input = { ...event(), payload: { ...event().payload, actor_id: 'user-who-clicked' }, input_data: {} };
  if (failure === 'missing') snapInsResources.mockResolvedValue({ data: { keyrings: {} } });
  if (failure === 'empty') snapInsResources.mockResolvedValue({ data: { keyrings: { newrelic_context: { secret: ' ' } } } });
  if (failure === 'expired') snapInsResources.mockResolvedValue({ data: { keyrings: { newrelic_context: { secret: 'private-nr-key', is_expired: true } } } });
  if (failure === 'lookup denied') snapInsResources.mockRejectedValue({ isAxiosError: true, response: { status: 403, data: 'private-nr-key' }, config: { headers: { authorization: 'bot-token' } } });
  await expect(run([input])).rejects.toThrow(/My Settings/);
  expect(worksGet).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
  expect(timelineEntriesCreate).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[newrelic-context\] fetch:failed code=connection_(missing|expired|lookup_failed)$/));
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(/private-nr-key|actor-token|bot-token|user-who-clicked/);
});

test('does not use an expired injected user connection', async () => {
  const input = { ...event(), input_data: { resources: { keyrings: { newrelic_context: { secret: 'private-nr-key', is_expired: true } } } } };
  await expect(run([input])).rejects.toThrow('Reauthorize');
  expect(worksGet).not.toHaveBeenCalled();
  expect(snapInsResources).not.toHaveBeenCalled();
});

test('accepts the parent issue field from DevRev’s Snap-kit example and the invocation request ID', async () => {
  const original = event();
  const input = {
    ...original,
    payload: { ...original.payload, context: { parent_core_object_id: 'ISS-1' }, request_id: '' },
    execution_metadata: { ...original.execution_metadata, request_id: 'invocation-1' },
  };
  await expect(run([input])).resolves.toMatchObject({ status: 'success' });
  expect(worksGet).toHaveBeenCalledWith({ id: 'ISS-1' }, { timeout: 10000 });
  const reference = timelineEntriesCreate.mock.calls[0][0].external_ref;
  await run([input]);
  expect(timelineEntriesCreate.mock.calls[1][0].external_ref).toBe(reference);
  input.execution_metadata.request_id = 'invocation-2';
  await run([input]);
  expect(timelineEntriesCreate.mock.calls[2][0].external_ref).not.toBe(reference);
});

test.each([undefined, '', ' '])('fetches context and deduplicates the reported timestamped click with request IDs %j', async (requestId) => {
  const original = event();
  const input = {
    ...original,
    payload: { ...original.payload, actor_id: 'clicking-user', request_id: requestId, action: { ...original.payload.action, timestamp: '2026-11-18T09:15:23.752Z' } },
    execution_metadata: { ...original.execution_metadata, request_id: requestId },
    input_data: { resources: { keyrings: {} } },
  };
  timelineEntriesCreate.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409 } });
  await expect(run([input])).resolves.toMatchObject({ status: 'success' });
  await expect(run([input])).resolves.toMatchObject({ status: 'success' });
  expect(snapInsResources).toHaveBeenCalledWith({ id: 'snap-1', user: 'clicking-user' }, { timeout: 10000 });
  expect(worksGet).toHaveBeenCalledWith({ id: 'ISS-1' }, { timeout: 10000 });
  expect(post).toHaveBeenCalledTimes(8);
  const refs = timelineEntriesCreate.mock.calls.map(([comment]) => comment.external_ref);
  expect(refs[0]).toMatch(/^newrelic-context:[a-f0-9]{64}$/);
  expect(refs[1]).toBe(refs[0]);
  expect(timelineEntriesList).toHaveBeenCalledTimes(1);
  expect(console.error).not.toHaveBeenCalled();
  expect(JSON.stringify((console.info as jest.Mock).mock.calls)).not.toMatch(/private-nr-key|actor-token|bot-token|clicking-user|2026-11-18/);
});

test('keeps a timestamped click stable across execution IDs and timestamp representations', async () => {
  const original = event();
  const input = {
    ...original,
    payload: { ...original.payload, request_id: '', action: { ...original.payload.action, timestamp: '2026-11-18T09:15:23.752Z' as string | number } },
    execution_metadata: { ...original.execution_metadata, request_id: 'execution-1' },
  };
  await run([input]);
  input.payload.action.timestamp = Date.parse('2026-11-18T09:15:23.752Z') / 1000;
  input.execution_metadata.request_id = 'execution-2';
  await run([input]);
  input.payload.action.timestamp = Date.parse('2026-11-18T09:15:23.752Z');
  input.execution_metadata.request_id = 'execution-3';
  await run([input]);
  const refs = timelineEntriesCreate.mock.calls.map(([comment]) => comment.external_ref);
  expect(new Set(refs).size).toBe(1);
});

test.each(['timestamp', 'issue', 'actor', 'window', 'installation'])('creates a separate comment identity when a request-ID-free click changes %s', async (changed) => {
  const original = event();
  const input = {
    ...original,
    payload: { ...original.payload, actor_id: 'clicking-user', request_id: '', action: { ...original.payload.action, timestamp: '2026-11-18T09:15:23.752Z' } },
  };
  await run([input]);
  if (changed === 'timestamp') input.payload.action.timestamp = '2026-11-18T09:15:23.753Z';
  if (changed === 'issue') {
    input.payload.context.object_id = 'ISS-2';
    worksGet.mockResolvedValue({ data: { work: { ...sourceWork(), id: 'ISS-2' } } });
  }
  if (changed === 'actor') input.payload.actor_id = 'another-user';
  if (changed === 'window') input.payload.action.value = 'recent';
  if (changed === 'installation') input.context.snap_in_id = 'snap-2';
  await run([input]);
  expect(timelineEntriesCreate.mock.calls[1][0].external_ref).not.toBe(timelineEntriesCreate.mock.calls[0][0].external_ref);
});

test('preserves payload request ID precedence when click and execution metadata change', async () => {
  const original = event();
  const input = {
    ...original,
    payload: { ...original.payload, action: { ...original.payload.action, timestamp: '2026-11-18T09:15:23.752Z' } },
    execution_metadata: { ...original.execution_metadata, request_id: 'execution-1' },
  };
  await run([input]);
  input.payload.action.timestamp = '2026-11-18T09:15:23.753Z';
  input.execution_metadata.request_id = 'execution-2';
  await run([input]);
  expect(timelineEntriesCreate.mock.calls[1][0].external_ref).toBe(timelineEntriesCreate.mock.calls[0][0].external_ref);
});

test.each([undefined, 'invalid-timestamp', NaN, Infinity, 8640000000000001])('allows a valid action without correlation metadata or a usable timestamp (%j)', async (timestamp) => {
  const original = event();
  const input = { ...original, payload: { ...original.payload, request_id: '', action: { ...original.payload.action, timestamp } } };
  await expect(run([input])).resolves.toMatchObject({ status: 'success' });
  await expect(run([input])).resolves.toMatchObject({ status: 'success' });
  expect(timelineEntriesCreate.mock.calls[1][0].external_ref).not.toBe(timelineEntriesCreate.mock.calls[0][0].external_ref);
  expect(console.info).toHaveBeenCalledWith('[newrelic-context] request:generated');
  expect(console.error).not.toHaveBeenCalled();
});

test('rejects ambiguous parent issue IDs before obtaining credentials', async () => {
  const input = { ...event(), payload: { ...event().payload, context: { object_id: 'ISS-1', parent_core_object_id: 'ISS-2' } } };
  await expect(run([input])).rejects.toThrow('conflicting issue IDs');
  expect(snapInsResources).not.toHaveBeenCalled();
  expect(worksGet).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith('[newrelic-context] fetch:failed code=conflicting_issue');
});

test('identifies the missing field with a fixed log code without echoing malformed event values', async () => {
  const input = { ...event(), payload: { ...event().payload, context: { object_id: { secret: 'private-nr-key' } } } };
  await expect(run([input])).rejects.toThrow('from a DevRev issue');
  expect(console.error).toHaveBeenCalledWith('[newrelic-context] fetch:failed code=missing_issue');
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('private-nr-key');
  expect(worksGet).not.toHaveBeenCalled();
});

test.each(['missing connection', 'missing actor', 'invalid action', 'invalid window'])('rejects %s before querying or posting', async (failure) => {
  const input = event();
  if (failure === 'missing connection') input.input_data.keyrings.newrelic_context = '';
  if (failure === 'missing actor') input.context.secrets.actor_session_token = '';
  if (failure === 'invalid action') input.payload.action.id = 'other';
  if (failure === 'invalid window') input.payload.action.value = 'all';
  await expect(run([input])).rejects.toThrow();
  expect(post).not.toHaveBeenCalled();
  expect(timelineEntriesCreate).not.toHaveBeenCalled();
});

test.each(['ticket', 'unrelated issue', 'mismatched IDs'])('refuses %s without a New Relic request', async (failure) => {
  const work = sourceWork();
  if (failure === 'ticket') work.type = 'ticket';
  if (failure === 'unrelated issue') work.sync_metadata.external_reference = 'https://example.com/issue/1';
  if (failure === 'mismatched IDs') work.sync_metadata.external_record_id = '456:other';
  worksGet.mockResolvedValue({ data: { work } });
  await expect(run([event()])).rejects.toThrow();
  expect(post).not.toHaveBeenCalled();
});

test('cannot use the bot to bypass an actor access denial', async () => {
  worksGet.mockRejectedValue({ isAxiosError: true, response: { status: 403 }, config: { headers: { authorization: 'actor-token' } } });
  await expect(run([event()])).rejects.toThrow('DevRev works.get failed (403)');
  expect(client.setup).toHaveBeenCalledTimes(1);
  expect(post).not.toHaveBeenCalled();
});

test('does not report success when posting the comment fails', async () => {
  timelineEntriesCreate.mockRejectedValue({ isAxiosError: true, response: { status: 403 } });
  await expect(run([event()])).rejects.toThrow('timeline-entries.create failed (403)');
});

test('does not mistake an unrelated conflict for a delivered comment', async () => {
  timelineEntriesCreate.mockRejectedValue({ isAxiosError: true, response: { status: 409 } });
  timelineEntriesList.mockResolvedValue({ data: { timeline_entries: [] } });
  await expect(run([event()])).rejects.toThrow('timeline-entries.create failed (409)');
});

test('retries reuse a unique external reference, but a deliberate new click gets another', async () => {
  timelineEntriesCreate.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409 } });
  await run([event()]);
  await run([event()]);
  const input = event(); input.payload.request_id = 'click-2';
  await run([input]);
  const refs = timelineEntriesCreate.mock.calls.map(([comment]) => comment.external_ref);
  expect(refs[0]).toBe(refs[1]);
  expect(refs[2]).not.toBe(refs[1]);
});

test('source lookup reports unavailable data instead of fetching unrelated telemetry', async () => {
  post.mockResolvedValue(graph({ aiIssues: { issues: { issues: [{ ...issue, issueId: 'other' }] } } }));
  await expect(run([event()])).rejects.toThrow('Source issue is unavailable');
  expect(timelineEntriesCreate).not.toHaveBeenCalled();
});

test('validates, caps and reports scope and time bounds', () => {
  const plan = planContext({ ...issue, entityGuids: Array.from({ length: 12 }, (_, i) => `guid${i}`) }, 'alert', now);
  expect(plan.entities).toHaveLength(10);
  expect(plan.omittedEntities).toBe(2);
  expect(plan.end - plan.start).toBe(1800000);
  expect(() => planContext({ ...issue, entityGuids: ["x') OR true --"] }, 'alert', now)).toThrow('invalid entity GUID');
  expect(() => planContext({ ...issue, createdAt: NaN }, 'alert', now)).toThrow('creation time');
  expect(planContext({ ...issue, createdAt: now - 1000 }, 'alert', now).end).toBe(now);
});

test.each(['http://one.newrelic.com', 'https://one.newrelic.com.evil.test', 'https://user:pass@one.newrelic.com', 'https://one.newrelic.com:444', 'https://one.eu.newrelic.com/redirect/issue/id?accountId=1%20OR%201', 'https://one.newrelic.com/redirect/issue/id?accountId=2147483648'])('rejects invalid source reference %s', (url) => {
  expect(() => parseIssueReference(url)).toThrow('source link');
});

test('caps comment content and scrubs credentials, emails and code fences from rows', () => {
  const plan = planContext(issue, 'alert', now);
  const rows = Array.from({ length: 100 }, () => ({ message: 'private-nr-key actor-token email@example.com ``` password=hunter2 Bearer abc.def.ghi {"api_key":"json-secret"} ' + 'x'.repeat(2000) }));
  const text = renderContext('https://one.newrelic.com', '123', plan, plan.queries.map((q) => ({ ...q, rows })), ['private-nr-key', 'actor-token']);
  expect(text.length).toBeLessThan(23000);
  expect(text).not.toMatch(/private-nr-key|actor-token|email@example.com|hunter2|abc.def.ghi|json-secret/);
  expect(text).toContain('limit reached');
  expect(text).toContain('[row truncated]');
  expect(redact('{"api_key":"secret key", "password":"pw"} cookie=session; mail=a@b.com')).not.toMatch(/secret key|"pw"|session|a@b.com/);
});

test('manifest routes real issue buttons to the exported handler with user credentials and optional scopes', () => {
  const { readFileSync } = require('fs');
  const { join } = require('path');
  const manifest = require('js-yaml').load(readFileSync(join(__dirname, '../../manifest.yaml'), 'utf8'));
  const { functionFactory } = require('../src/function-factory');
  expect(manifest.functions.map((f: { name: string }) => f.name)).toContain('fetch_newrelic_context');
  expect(functionFactory.fetch_newrelic_context).toBe(run);
  expect(manifest.keyrings.user[0]).toMatchObject({ name: 'newrelic_context', types: ['newrelic-user-key'] });
  expect(manifest.snap_kit_actions[0]).toMatchObject({ name: 'fetch_newrelic_context', function: 'fetch_newrelic_context' });
  expect(manifest.snap_components[0]).toMatchObject({ surface: 'issue', snap_kit_action_name: 'fetch_newrelic_context' });
  const buttons = manifest.snap_components[0].snap_kit_body.snaps[0].elements[1].elements;
  expect(buttons.map((b: { value: string }) => b.value)).toEqual(['alert', 'recent']);
  expect(buttons.every((b: { action_id: string }) => b.action_id === 'fetch_newrelic_context')).toBe(true);
  expect(manifest.service_account.scopes.impersonate[0]).toEqual({ act_as: 'all_devusers', scopes: [
    expect.objectContaining({ scope: 'issue:read', optional: true }),
  ] });
});

test('NRQL rejects partial errors and uses account/query variables', async () => {
  const client = new HttpClient({ org_id: 'US', key: 'key' });
  await client.nrql('123', 'FROM Span SELECT count(*) LIMIT 1');
  expect(post).toHaveBeenLastCalledWith('', { query: expect.stringContaining('$query: Nrql!'), variables: { accountId: 123, query: 'FROM Span SELECT count(*) LIMIT 1' } });
  post.mockResolvedValue({ data: { errors: [{ message: 'key denied' }], data: { actor: { account: { nrql: { results: [] } } } } } });
  await expect(client.nrql('123', 'SELECT count(*) FROM Log')).rejects.toThrow('rejected');
});
