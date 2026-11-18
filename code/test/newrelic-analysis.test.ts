import { client } from '@devrev/typescript-sdk';
import { readFileSync } from 'fs';
import { join } from 'path';

import fetchContext from '../src/functions/fetch_newrelic_context';
import complete from '../src/functions/complete_newrelic_analysis';
import { analysisPrompt, PENDING_PREFIX, RESPONSE_SOURCE } from '../src/functions/fetch_newrelic_context/analysis';
import { planContext } from '../src/functions/fetch_newrelic_context/context';
import { HttpClient } from '../src/functions/external-system/http-client';
import { issuePermalink } from '../src/functions/external-system/links';
import { githubRepository, githubResult } from '../src/functions/fetch_newrelic_context/github-policy';

jest.mock('@devrev/typescript-sdk', () => ({ ...jest.requireActual('@devrev/typescript-sdk'), client: { setup: jest.fn(), setupBeta: jest.fn() } }));

const now = Date.parse('2026-11-18T09:35:00Z');
const core = 'don:core:dvrv-us-1:devo/test';
const issueId = core + ':issue/1';
const agentId = core + ':ai_agent/6';
const githubAgentId = core + ':ai_agent/7';
const repository = 'harrykimpel/O11yParty-Buzzer';
const snapInId = 'don:integration:dvrv-us-1:devo/test:snap_in/current';
const serviceAccountId = 'don:identity:dvrv-us-1:devo/test:svc_acc/newrelic';
const issue = { issueId: 'source-issue', title: ['Latency'], state: 'ACTIVATED', priority: 'CRITICAL', createdAt: now - 3600000, updatedAt: now, entityGuids: ['YWJj'] };
const sourceUrl = issuePermalink('123', issue.issueId, 'US');
const work = { id: issueId, type: 'issue', title: 'Latency actor-token', created_date: new Date(issue.createdAt).toISOString(), sync_metadata: { external_reference: sourceUrl, external_record_id: '123:source-issue' } };
const actor = { worksGet: jest.fn(), timelineEntriesCreate: jest.fn(), timelineEntriesList: jest.fn() };
const bot = { timelineEntriesCreate: jest.fn(), timelineEntriesList: jest.fn(), timelineEntriesGet: jest.fn(), timelineEntriesUpdate: jest.fn() };
const agent = { aiAgentEventsExecuteAsync: jest.fn() };
let comment: Record<string, any>;

function click(value = 'alert') {
  return { payload: { action: { id: 'fetch_newrelic_context', value, timestamp: '2026-11-18T09:35:57.958Z' }, context: { object_id: issueId }, actor_id: 'user-1' },
    context: { snap_in_id: snapInId, service_account_id: serviceAccountId, secrets: { actor_session_token: 'actor-token', service_account_token: 'bot-token' } },
    execution_metadata: { devrev_endpoint: 'https://api.devrev.ai' },
    input_data: { global_values: { analysis_agent_id: agentId, github_issue_agent_id: githubAgentId, github_issue_repository: repository }, event_sources: { [RESPONSE_SOURCE]: 'event-source-1' }, keyrings: { newrelic_context: 'private-nr-key' } } };
}
function response(type = 'message', message = 'Latency is elevated; inspect the payment dependency.') {
  const request = agent.aiAgentEventsExecuteAsync.mock.calls[0][0];
  return { ...click(), payload: { type: 'ai_agent_response', ai_agent_response: {
    agent: request.agent, agent_response: type, message, session: core + ':ai_agent_session/1',
    session_object: request.session_object, client_metadata: { ...request.client_metadata },
  } } };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(HttpClient.prototype, 'getIssue').mockResolvedValue(issue);
  jest.spyOn(HttpClient.prototype, 'nrql').mockResolvedValue([{ value: 42, message: 'private-nr-key bot-token actor-token user@example.com password=secret' }]);
  (client.setup as jest.Mock).mockImplementation(({ token }) => token === 'actor-token' ? actor : bot);
  (client.setupBeta as jest.Mock).mockReturnValue(agent);
  actor.worksGet.mockResolvedValue({ data: { work } });
  actor.timelineEntriesList.mockResolvedValue({ data: { timeline_entries: [{ id: issueId + ':comment/source-analysis', object: issueId,
    type: 'timeline_comment', visibility: 'internal', created_by: { id: serviceAccountId }, created_date: new Date(now - 1000).toISOString(),
    external_ref: 'newrelic-analysis:' + 'a'.repeat(64), body: '## New Relic analysis\n\nCompleted latency analysis. NRAK-secret actor-token bot-token' }] } });
  bot.timelineEntriesCreate.mockImplementation(async (request) => {
    comment = { ...request, id: issueId + ':comment/analysis', created_by: { id: serviceAccountId }, created_date: new Date(now).toISOString() };
    return { data: { timeline_entry: comment } };
  });
  bot.timelineEntriesGet.mockImplementation(async () => ({ data: { timeline_entry: comment } }));
  bot.timelineEntriesList.mockImplementation(async () => ({ data: { timeline_entries: [comment] } }));
  bot.timelineEntriesUpdate.mockImplementation(async (request) => { comment = { ...comment, body: request.body }; return { data: { timeline_entry: comment } }; });
  agent.aiAgentEventsExecuteAsync.mockResolvedValue({ data: { session: { id: core + ':ai_agent_session/1' } } });
});
afterEach(() => jest.restoreAllMocks());

test.each(['alert', 'recent'])('collects both windows and queues the configured agent for %s without posting raw telemetry', async (mode) => {
  await expect(fetchContext([click(mode)])).resolves.toMatchObject({ status: 'success' });
  expect(actor.worksGet).toHaveBeenCalledWith({ id: issueId }, { timeout: 10000 });
  expect(HttpClient.prototype.nrql).toHaveBeenCalledTimes(6);
  expect(bot.timelineEntriesCreate).toHaveBeenCalledWith(expect.objectContaining({ object: issueId, visibility: 'internal', body: expect.stringMatching(/^## New Relic analysis requested/) }), { timeout: 10000 });
  expect(comment.body).not.toContain('42');
  expect(actor.timelineEntriesCreate).not.toHaveBeenCalled();
  const request = agent.aiAgentEventsExecuteAsync.mock.calls[0][0];
  expect(client.setupBeta).toHaveBeenCalledWith({ endpoint: 'https://api.devrev.ai', token: 'actor-token' });
  expect(request).toMatchObject({ agent: agentId, parent: issueId, target: 'event_source_target', event_source_target: { event_source: 'event-source-1' } });
  const prompt = request.event.input_message.message;
  const data = JSON.parse(prompt.split('\nEVIDENCE\n')[1]);
  expect(data.windows.map((window: { mode: string }) => window.mode)).toEqual(['alert', 'recent']);
  expect(data.windows[0].start_utc).toBe(new Date(issue.createdAt - 900000).toISOString());
  expect(data.windows[1].end_utc).toBe(new Date(now).toISOString());
  expect(prompt.length).toBeLessThanOrEqual(16384);
  expect(JSON.stringify(request)).not.toMatch(/private-nr-key|actor-token|bot-token|user@example.com|password=secret/);
  expect(JSON.stringify((console.info as jest.Mock).mock.calls)).not.toMatch(/private-nr-key|actor-token|bot-token/);
});

test('posts the final scrubbed brief by updating exactly the bound internal comment', async () => {
  await fetchContext([click()]);
  await complete([response('message', 'NRAK-secret user@example.com password=secret bot-token\nCheck latency.')]);
  expect(bot.timelineEntriesGet).toHaveBeenCalledWith({ id: issueId + ':comment/analysis' }, { timeout: 10000 });
  expect(bot.timelineEntriesUpdate).toHaveBeenCalledTimes(1);
  expect(comment.body).toContain('Check latency.');
  expect(comment.body).toContain('AI-generated analysis');
  expect(comment.body).toContain(sourceUrl);
  expect(comment.body).not.toMatch(/NRAK-secret|user@example.com|password=secret|bot-token/);
  expect(HttpClient.prototype.nrql).toHaveBeenCalledTimes(6);
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
});

test('deduplicates delivery retries before invoking the agent a second time', async () => {
  await fetchContext([click()]);
  bot.timelineEntriesCreate.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409 } });
  await expect(fetchContext([click()])).resolves.toMatchObject({ status: 'success' });
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
  await complete([response()]);
  await complete([response()]);
  await complete([response('error')]);
  expect(bot.timelineEntriesUpdate).toHaveBeenCalledTimes(1);
});

test.each(['progress', 'message_generation_started', 'suggestions'])('ignores %s notifications without touching the comment', async (type) => {
  await fetchContext([click()]);
  await complete([response(type)]);
  expect(bot.timelineEntriesGet).not.toHaveBeenCalled();
  expect(bot.timelineEntriesUpdate).not.toHaveBeenCalled();
});

test.each(['wrong agent', 'wrong installation', 'wrong issue', 'wrong session', 'wrong reference', 'wrong author', 'external comment', 'expired', 'already completed'])('rejects or ignores a completion with %s', async (failure) => {
  await fetchContext([click()]);
  const input = response();
  if (failure === 'wrong agent') input.payload.ai_agent_response.agent = core + ':ai_agent/7';
  if (failure === 'wrong installation') input.context.snap_in_id = 'another-installation';
  if (failure === 'wrong issue') input.payload.ai_agent_response.client_metadata.issue_id = core + ':issue/2';
  if (failure === 'wrong session') input.payload.ai_agent_response.session_object = 'unrelated';
  if (failure === 'wrong reference') comment.external_ref = 'unrelated';
  if (failure === 'wrong author') comment.created_by.id = 'another-user';
  if (failure === 'external comment') comment.visibility = 'external';
  if (failure === 'expired') comment.created_date = new Date(now - 31 * 60000).toISOString();
  if (failure === 'already completed') comment.body = 'Already completed.';
  await complete([input]).catch(() => undefined);
  expect(bot.timelineEntriesUpdate).not.toHaveBeenCalled();
});

test.each(['error', 'empty'])('replaces pending status with a safe failure notice for %s output', async (failure) => {
  await fetchContext([click()]);
  const input = response(failure === 'error' ? 'error' : 'message', failure === 'error' ? 'private-nr-key bot-token' : ' ');
  await complete([input]);
  expect(comment.body).toContain('analysis unavailable');
  expect(comment.body).not.toMatch(/private-nr-key|bot-token/);
});

test('never replaces a previously completed result when a retry notification arrives', async () => {
  await fetchContext([click()]);
  await complete([response()]);
  const body = comment.body;
  await complete([response('error', 'Failure from another delivery')]);
  expect(comment.body).toBe(body);
  expect(bot.timelineEntriesUpdate).toHaveBeenCalledTimes(1);
});

test('does not post results when the bound comment cannot be read, and sanitizes retry errors', async () => {
  await fetchContext([click()]);
  bot.timelineEntriesGet.mockRejectedValue({ config: { headers: { Authorization: 'bot-token' } }, response: { data: 'private-nr-key' } });
  await expect(complete([response()])).rejects.toThrow('Check the fixed failure code');
  expect(bot.timelineEntriesUpdate).not.toHaveBeenCalled();
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(/bot-token|private-nr-key/);
});

test('contains start failures without leaking prompts or raw SDK errors', async () => {
  agent.aiAgentEventsExecuteAsync.mockRejectedValue({ config: { headers: { Authorization: 'actor-token' }, data: 'private-nr-key' } });
  await expect(fetchContext([click()])).rejects.toThrow('Could not start');
  expect(comment.body).toContain('analysis unavailable');
  expect(console.error).toHaveBeenCalledWith('[newrelic-context] fetch:failed code=agent_start_failed');
});

test('preserves a fast completed brief when the initiating agent request subsequently reports a transport error', async () => {
  agent.aiAgentEventsExecuteAsync.mockImplementationOnce(async () => {
    await complete([response('message', 'A completed incident brief.')]);
    throw new Error('late transport failure');
  });
  await expect(fetchContext([click()])).resolves.toMatchObject({ status: 'success' });
  expect(comment.body).toContain('A completed incident brief.');
  expect(comment.body).not.toContain('analysis unavailable');
  expect(bot.timelineEntriesUpdate).toHaveBeenCalledTimes(1);
});

test('the manifest connects the response automation, configurable agent and optional bot permission', () => {
  const { readFileSync } = require('fs');
  const { join } = require('path');
  const manifest = require('js-yaml').load(readFileSync(join(__dirname, '../../manifest.yaml'), 'utf8'));
  expect(manifest.inputs.organization).toContainEqual(expect.objectContaining({ name: 'analysis_agent_id', is_required: false }));
  expect(manifest.service_account.scopes.self).toContainEqual(expect.objectContaining({ scope: 'issue:read', optional: true }));
  expect(manifest.event_sources.organization).toContainEqual(expect.objectContaining({ name: RESPONSE_SOURCE, type: 'devrev-webhook', config: { event_types: ['ai_agent_response'] } }));
  expect(manifest.automations).toContainEqual(expect.objectContaining({ source: RESPONSE_SOURCE, event_types: ['ai_agent_response'], function: 'complete_newrelic_analysis' }));
  expect(manifest.snap_components[0].snap_kit_body.snaps[0].elements[2].elements.map((button: { value: string }) => button.value)).toEqual(['evidence', 'recent_evidence']);
});

test.each(['actor denied', 'bot denied', 'agent missing', 'agent wrong org', 'event source missing'])('does not invoke the agent when %s', async (failure) => {
  const input = click();
  if (failure === 'actor denied') actor.worksGet.mockRejectedValue({ isAxiosError: true, response: { status: 403 } });
  if (failure === 'bot denied') bot.timelineEntriesCreate.mockRejectedValue({ isAxiosError: true, response: { status: 403 } });
  if (failure === 'agent missing') input.input_data.global_values.analysis_agent_id = '';
  if (failure === 'agent wrong org') input.input_data.global_values.analysis_agent_id = 'don:core:dvrv-us-1:devo/other:ai_agent/6';
  if (failure === 'event source missing') input.input_data.event_sources[RESPONSE_SOURCE] = '';
  await expect(fetchContext([input])).rejects.toThrow();
  expect(agent.aiAgentEventsExecuteAsync).not.toHaveBeenCalled();
  if (failure !== 'bot denied') expect(bot.timelineEntriesCreate).not.toHaveBeenCalled();
});

test('bounds oversized evidence with explicit omissions and sampling instructions', () => {
  const oversized = { ...issue, entityGuids: Array.from({ length: 10 }, (_, i) => ('a'.repeat(250) + i)) };
  const snapshots = (['alert', 'recent'] as const).map((mode) => {
    const plan = planContext(oversized, mode, now);
    return { mode, plan, results: plan.queries.map((query) => ({ ...query, rows: Array.from({ length: 20 }, () => ({ message: 'private-nr-key ' + 'x'.repeat(4000) })) })) };
  });
  const prompt = analysisPrompt('Latency', sourceUrl, oversized, snapshots, 'alert', ['private-nr-key']);
  expect(prompt.length).toBeLessThanOrEqual(16384);
  expect(prompt).toContain('omitted_rows');
  expect(prompt).toContain('[row truncated]');
  expect(prompt).toContain('not totals or complete traces');
  expect(prompt).not.toContain('private-nr-key');
});

test('keeps partial query failures and missing entity evidence explicit for the agent', async () => {
  (HttpClient.prototype.nrql as jest.Mock).mockRejectedValue(new Error('raw backend failure'));
  await fetchContext([click()]);
  const request = agent.aiAgentEventsExecuteAsync.mock.calls[0][0];
  expect(request.event.input_message.message).toContain('Query failed. Check New Relic permissions');
  expect(request.event.input_message.message).not.toContain('raw backend failure');
  expect(comment.body).toMatch(new RegExp('^' + PENDING_PREFIX));
});

test('requests an honest insufficient-evidence brief when the source alert has no entity GUIDs', async () => {
  (HttpClient.prototype.getIssue as jest.Mock).mockResolvedValue({ ...issue, entityGuids: [] });
  await fetchContext([click()]);
  expect(HttpClient.prototype.nrql).not.toHaveBeenCalled();
  const prompt = agent.aiAgentEventsExecuteAsync.mock.calls[0][0].event.input_message.message;
  expect(prompt).toContain('"no_entity_guids":true');
  expect(prompt).toContain('Missing or empty data does not mean healthy');
});

test('on-demand GitHub handoff reads the completed analysis as the user without fetching telemetry or requiring a New Relic key', async () => {
  const input = click('github');
  input.input_data.keyrings.newrelic_context = '';
  await expect(fetchContext([input])).resolves.toMatchObject({ status: 'success' });
  expect(HttpClient.prototype.getIssue).not.toHaveBeenCalled();
  expect(HttpClient.prototype.nrql).not.toHaveBeenCalled();
  expect(actor.timelineEntriesList).toHaveBeenCalledWith(expect.objectContaining({ object: issueId, visibility: ['internal'], limit: 100 }), { timeout: 10000 });
  const request = agent.aiAgentEventsExecuteAsync.mock.calls[0][0];
  expect(request.agent).toBe(githubAgentId);
  expect(request.client_metadata.connector).toBe('newrelic-github-v1');
  expect(request.client_metadata.github).toEqual({ repository, analysis_comment_id: issueId + ':comment/source-analysis' });
  const prompt = request.event.input_message.message;
  const data = JSON.parse(prompt.split('\nINPUT\n')[1]);
  expect(data.analysis).toContain('Completed latency analysis.');
  expect(data.repository).toBe(repository);
  expect(data.correlation_marker).toMatch(/^newrelic-incident:[a-f0-9]{64}$/);
  expect(prompt).toContain('Search issues');
  expect(prompt).not.toMatch(/NRAK-secret|actor-token|bot-token/);
  expect(comment.body).toContain('GitHub issue requested');
});

test.each(['created', 'existing'])('posts a validated GitHub URL when the agent reports %s', async (status) => {
  await fetchContext([click('github')]);
  await complete([response('message', JSON.stringify({ status, url: 'https://github.com/' + repository + '/issues/42', issue_number: 42 }))]);
  expect(comment.body).toContain('https://github.com/' + repository + '/issues/42');
  expect(comment.body).toContain(status === 'created' ? 'Agent reported: created' : 'Agent reported: found existing');
  await complete([response('message', JSON.stringify({ status, url: 'https://github.com/' + repository + '/issues/42', issue_number: 42 }))]);
  expect(bot.timelineEntriesUpdate).toHaveBeenCalledTimes(1);
});

test('completes the internal result comment using the actual prose-prefixed, Markdown-linked agent reply', async () => {
  await fetchContext([click('github')]);
  const message = readFileSync(join(__dirname, 'fixtures/github-agent-reply.txt'), 'utf8');
  await complete([response('message', message)]);
  expect(comment.body).toContain('[GitHub issue #165](<https://github.com/' + repository + '/issues/165>)');
  expect(comment.body).not.toContain('request unavailable');
  expect(comment.body).not.toContain('Issue verified.');
  expect(bot.timelineEntriesUpdate).toHaveBeenCalledTimes(1);
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
});

test.each(['no analysis', 'pending', 'raw evidence', 'other author', 'external', 'wrong issue', 'failure notice'])('does not create a GitHub request from %s', async (failure) => {
  const entries = (await actor.timelineEntriesList()).data.timeline_entries;
  if (failure === 'pending') entries[0].body = PENDING_PREFIX + 'Pending';
  if (failure === 'raw evidence') entries[0].body = '## New Relic context\n\nRaw rows';
  if (failure === 'other author') entries[0].created_by.id = 'another-user';
  if (failure === 'external') entries[0].visibility = 'external';
  if (failure === 'wrong issue') entries[0].object = core + ':issue/2';
  if (failure === 'failure notice') entries[0].body = '## New Relic analysis unavailable\n\nFailed';
  actor.timelineEntriesList.mockResolvedValue({ data: { timeline_entries: failure === 'no analysis' ? [] : entries } });
  await expect(fetchContext([click('github')])).rejects.toThrow('wait for its completed brief');
  expect(agent.aiAgentEventsExecuteAsync).not.toHaveBeenCalled();
  expect(bot.timelineEntriesCreate).not.toHaveBeenCalled();
});

test('uses the latest completed brief, with a stable incident marker across refreshed analyses', async () => {
  await fetchContext([click('github')]);
  const first = JSON.parse(agent.aiAgentEventsExecuteAsync.mock.calls[0][0].event.input_message.message.split('\nINPUT\n')[1]);
  const entries = (await actor.timelineEntriesList()).data.timeline_entries;
  entries.push({ ...entries[0], id: issueId + ':comment/new-analysis', body: '## New Relic analysis\n\nNew completed analysis.', modified_date: new Date(now).toISOString() });
  const next = click('github');
  next.payload.action.timestamp = '2026-11-18T09:36:00Z';
  await fetchContext([next]);
  const second = JSON.parse(agent.aiAgentEventsExecuteAsync.mock.calls[1][0].event.input_message.message.split('\nINPUT\n')[1]);
  expect(second.analysis_comment_id).toBe(issueId + ':comment/new-analysis');
  expect(second.correlation_marker).toBe(first.correlation_marker);
});

test('does not repeat a delivered GitHub click when a newer analysis appears before its retry', async () => {
  await fetchContext([click('github')]);
  const entries = (await actor.timelineEntriesList()).data.timeline_entries;
  entries.push({ ...entries[0], id: issueId + ':comment/new-analysis', body: '## New Relic analysis\n\nNew analysis.', modified_date: new Date(now).toISOString() });
  entries.push(comment);
  await expect(fetchContext([click('github')])).resolves.toMatchObject({ status: 'success' });
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
  expect(bot.timelineEntriesCreate).toHaveBeenCalledTimes(1);
});

test.each(['repository missing', 'agent missing', 'analysis access denied'])('does not publish a handoff when %s', async (failure) => {
  const input = click('github');
  if (failure === 'repository missing') input.input_data.global_values.github_issue_repository = '';
  if (failure === 'agent missing') input.input_data.global_values.github_issue_agent_id = '';
  if (failure === 'analysis access denied') actor.timelineEntriesList.mockRejectedValue({ config: { headers: { Authorization: 'actor-token' } } });
  await expect(fetchContext([input])).rejects.toThrow();
  expect(bot.timelineEntriesCreate).not.toHaveBeenCalled();
  expect(agent.aiAgentEventsExecuteAsync).not.toHaveBeenCalled();
});

test.each(['wrong repository', 'wrong agent', 'tampered source analysis'])('rejects a GitHub result with %s routing', async (failure) => {
  await fetchContext([click('github')]);
  const input = response('message', JSON.stringify({ status: 'created', url: 'https://github.com/' + repository + '/issues/42', issue_number: 42 }));
  if (failure === 'wrong repository') input.input_data.global_values.github_issue_repository = 'other/repo';
  if (failure === 'wrong agent') input.payload.ai_agent_response.agent = agentId;
  if (failure === 'tampered source analysis') input.payload.ai_agent_response.client_metadata.github.analysis_comment_id = issueId + ':comment/unrelated';
  await complete([input]).catch(() => undefined);
  expect(bot.timelineEntriesUpdate).not.toHaveBeenCalled();
});

test.each(['not JSON', '{"status":"error"}', '{"status":"created","url":"https://evil.test/issues/42","issue_number":42}', '{"status":"created","url":"https://github.com/other/repo/issues/42","issue_number":42}'])('does not present an invalid GitHub agent report as success: %s', async (message) => {
  await fetchContext([click('github')]);
  await complete([response('message', message)]);
  expect(comment.body).toContain('GitHub issue request unavailable');
  expect(comment.body).not.toContain('evil.test');
});

test.each(['https://github.com/harrykimpel/O11yParty-Buzzer/issues/42?token=x', 'https://user:pass@github.com/harrykimpel/O11yParty-Buzzer/issues/42', 'https://github.com/harrykimpel/O11yParty-Buzzer/pull/42', 'https://github.com.evil.test/harrykimpel/O11yParty-Buzzer/issues/42'])('rejects an unsafe or unrelated GitHub result URL %s', (url) => {
  expect(githubResult(JSON.stringify({ status: 'created', url, issue_number: 42 }), repository)).toBeUndefined();
});

test('requires matching returned issue numbers and supports fenced JSON from an otherwise valid agent result', () => {
  expect(githubResult(JSON.stringify({ status: 'created', url: 'https://github.com/' + repository + '/issues/42', issue_number: 43 }), repository)).toBeUndefined();
  expect(githubResult('```json\n' + JSON.stringify({ status: 'existing', url: 'https://github.com/' + repository + '/issues/42', issue_number: 42 }) + '\n```', repository)).toContain('found existing');
  expect(githubRepository('https://github.com/' + repository)).toBeUndefined();
  expect(githubRepository('owner/..')).toBeUndefined();
});
