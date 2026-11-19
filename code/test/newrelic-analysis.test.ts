import { client } from '@devrev/typescript-sdk';
import { readFileSync } from 'fs';
import { join } from 'path';

import fetchContext from '../src/functions/fetch_newrelic_context';
import complete from '../src/functions/complete_newrelic_analysis';
import { analysisPrompt, analysisReference, PENDING_PREFIX, RESPONSE_SOURCE } from '../src/functions/fetch_newrelic_context/analysis';
import { planContext } from '../src/functions/fetch_newrelic_context/context';
import { HttpClient, NewRelicAcknowledgmentError, NewRelicInvestigationError } from '../src/functions/external-system/http-client';
import { issuePermalink } from '../src/functions/external-system/links';
import { githubRepository, githubResult } from '../src/functions/fetch_newrelic_context/github-policy';
import { triageResult } from '../src/functions/fetch_newrelic_context/triage-policy';

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
const agent = { aiAgentEventsExecuteAsync: jest.fn(), snapInsResources: jest.fn() };
let comment: Record<string, any>;
let records: Map<string, Record<string, any>>;
let investigationReports: Map<string, Record<string, any>>;

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
  comment = {};
  records = new Map();
  investigationReports = new Map();
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
    if (request.visibility === 'private') {
      if (records.has(request.external_ref)) throw { isAxiosError: true, response: { status: 409 } };
      const record = { ...request, id: issueId + ':comment/record-' + records.size, created_by: { id: serviceAccountId }, created_date: new Date(now).toISOString() };
      records.set(request.external_ref, record);
      return { data: { timeline_entry: record } };
    }
    if (request.external_ref.startsWith('newrelic-investigation-report:')) {
      if (investigationReports.has(request.external_ref)) throw { isAxiosError: true, response: { status: 409 } };
      const report = { ...request, id: issueId + ':comment/investigation', created_by: { id: serviceAccountId } };
      investigationReports.set(request.external_ref, report);
      return { data: { timeline_entry: report } };
    }
    if (comment.external_ref === request.external_ref) throw { isAxiosError: true, response: { status: 409 } };
    comment = { ...request, id: issueId + ':comment/analysis', created_by: { id: serviceAccountId }, created_date: new Date(now).toISOString() };
    return { data: { timeline_entry: comment } };
  });
  bot.timelineEntriesGet.mockImplementation(async ({ id, external_ref }) => ({ data: { timeline_entry: external_ref ? records.get(external_ref)
    : [...records.values()].find((entry) => entry.id === id) ?? comment } }));
  bot.timelineEntriesList.mockImplementation(async ({ visibility } = {}) => ({ data: { timeline_entries: visibility?.includes('private') ? [...records.values()] : [comment, ...investigationReports.values()] } }));
  bot.timelineEntriesUpdate.mockImplementation(async (request) => { comment = { ...comment, body: request.body }; return { data: { timeline_entry: comment } }; });
  agent.aiAgentEventsExecuteAsync.mockResolvedValue({ data: { session: { id: core + ':ai_agent_session/1' } } });
  agent.snapInsResources.mockResolvedValue({ data: { keyrings: { newrelic_context: { secret: 'private-nr-key', is_expired: false } } } });
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
  expect(comment.body).toContain('analysis requested');
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
  expect(manifest.snap_components[0].snap_kit_body.snaps[0].elements[3].elements.map((button: { value: string }) => button.value)).toEqual(['evidence', 'recent_evidence']);
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
  expect(request.client_metadata.connector).toBe('newrelic-github-v2');
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
  expect(bot.timelineEntriesCreate).toHaveBeenCalledTimes(2); // Internal request plus private source-brief binding.
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

test.each(['alert', 'github'])('allows a successful callback after an uncertain %s start response', async (mode) => {
  agent.aiAgentEventsExecuteAsync.mockRejectedValueOnce(new Error('transport timeout'));
  await expect(fetchContext([click(mode)])).rejects.toThrow('Could not start or confirm');
  expect(comment.body).toContain('requested');
  expect(bot.timelineEntriesUpdate).not.toHaveBeenCalled();
  const message = mode === 'github'
    ? JSON.stringify({ status: 'created', url: 'https://github.com/' + repository + '/issues/42', issue_number: 42 }) : 'Recovered incident brief';
  await complete([response('message', message)]);
  expect(comment.body).toContain(mode === 'github' ? 'GitHub issue #42' : 'Recovered incident brief');
});

test('concurrent success and error callbacks publish the same durable winning result', async () => {
  await fetchContext([click()]);
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const originalGet = bot.timelineEntriesGet.getMockImplementation()!;
  bot.timelineEntriesGet.mockImplementation(async (request) => {
    if (request.external_ref) return originalGet(request);
    const snapshot = { ...comment };
    if (++reads === 2) release();
    await bothRead;
    return { data: { timeline_entry: snapshot } };
  });
  await Promise.all([complete([response('message', 'The successful brief wins.')]), complete([response('error', 'late error')])]);
  expect(comment.body).toContain('The successful brief wins.');
  expect(bot.timelineEntriesUpdate).toHaveBeenCalledTimes(2);
  const bodies = bot.timelineEntriesUpdate.mock.calls.map(([request]) => request.body);
  expect(new Set(bodies).size).toBe(1);
  expect(records.size).toBe(1);
});

test('a lost terminal-record create response is reconciled before publishing', async () => {
  await fetchContext([click()]);
  const originalCreate = bot.timelineEntriesCreate.getMockImplementation()!;
  bot.timelineEntriesCreate.mockImplementationOnce(async (request) => {
    await originalCreate(request);
    throw new Error('response lost after durable create');
  });
  await complete([response('message', 'Recovered persisted result.')]);
  expect(comment.body).toContain('Recovered persisted result.');
  expect(records.size).toBe(1);
});

test('retries a failed discussion update using the persisted winner instead of a later error', async () => {
  await fetchContext([click()]);
  bot.timelineEntriesUpdate.mockRejectedValueOnce(new Error('temporary update failure'));
  await expect(complete([response('message', 'The persisted result.')])).rejects.toThrow();
  expect(comment.body).toContain('analysis requested');
  await complete([response('error')]);
  expect(comment.body).toContain('The persisted result.');
});

test('overlapping deliveries with different selected briefs reserve one GitHub request', async () => {
  const entries = (await actor.timelineEntriesList()).data.timeline_entries;
  actor.timelineEntriesList.mockResolvedValueOnce({ data: { timeline_entries: entries } });
  actor.timelineEntriesList.mockResolvedValueOnce({ data: { timeline_entries: [{ ...entries[0], id: issueId + ':comment/new-brief' }] } });
  await Promise.all([fetchContext([click('github')]), fetchContext([click('github')])]);
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
  const request = agent.aiAgentEventsExecuteAsync.mock.calls[0][0];
  expect(request.client_metadata.github.analysis_comment_id).toBe(entries[0].id);
  await complete([response('message', JSON.stringify({ status: 'existing', url: 'https://github.com/' + repository + '/issues/42', issue_number: 42 }))]);
  expect(comment.body).toContain('GitHub issue #42');
});

test('continues to accept an in-flight legacy GitHub callback', async () => {
  await fetchContext([click('github')]);
  const input = response('message', JSON.stringify({ status: 'existing', url: 'https://github.com/' + repository + '/issues/42', issue_number: 42 }));
  const metadata = input.payload.ai_agent_response.client_metadata;
  metadata.connector = 'newrelic-github-v1';
  comment.external_ref = analysisReference(metadata);
  input.payload.ai_agent_response.session_object = comment.external_ref;
  await complete([input]);
  expect(comment.body).toContain('GitHub issue #42');
});

test.each(['alert', 'evidence', 'github'])('accepts a display ID and uses the canonical issue DON for %s downstream', async (mode) => {
  const input = click(mode);
  input.payload.context.object_id = 'ISS-1';
  actor.worksGet.mockResolvedValueOnce({ data: { work: { ...work, display_id: 'ISS-1' } } });
  await fetchContext([input]);
  expect(actor.worksGet).toHaveBeenCalledWith({ id: 'ISS-1' }, { timeout: 10000 });
  if (mode === 'evidence') expect(actor.timelineEntriesCreate).toHaveBeenCalledWith(expect.objectContaining({ object: issueId }), { timeout: 10000 });
  else expect(agent.aiAgentEventsExecuteAsync.mock.calls[0][0].parent).toBe(issueId);
});

test.each(['author', 'object', 'visibility', 'reference', 'id'])('does not publish a result from a private record with a wrong %s', async (field) => {
  await fetchContext([click()]);
  bot.timelineEntriesCreate.mockImplementationOnce(async (request) => {
    const record = { ...request, id: issueId + ':comment/record', created_by: { id: serviceAccountId } };
    if (field === 'author') record.created_by = { id: 'other-user' };
    if (field === 'object') record.object = core + ':issue/2';
    if (field === 'visibility') record.visibility = 'internal';
    if (field === 'reference') record.external_ref = 'unrelated';
    if (field === 'id') record.id = core + ':issue/2:comment/record';
    records.set(request.external_ref, record);
    return { data: { timeline_entry: record } };
  });
  await expect(complete([response()])).rejects.toThrow('Check the fixed failure code');
  expect(bot.timelineEntriesUpdate).not.toHaveBeenCalled();
  expect(comment.body).toContain('analysis requested');
});

test('completes the reported existing-issue reply through the stored binding record ID', async () => {
  await fetchContext([click('github')]);
  const event = response('message', readFileSync(join(__dirname, 'fixtures/github-agent-existing-reply.txt'), 'utf8'));
  expect(event.payload.ai_agent_response.client_metadata.binding_record_id).toBe(issueId + ':comment/record-0');
  await complete([event]);
  expect(bot.timelineEntriesGet).toHaveBeenCalledWith({ id: issueId + ':comment/record-0' }, { timeout: 10000 });
  expect(comment.body).toContain('[GitHub issue #166](<https://github.com/' + repository + '/issues/166>)');
});

test.each(['unsupported query', 'ignored query'])('completes an older v2 request when external-reference GET has an %s', async (behavior) => {
  await fetchContext([click('github')]);
  const event = response('message', readFileSync(join(__dirname, 'fixtures/github-agent-existing-reply.txt'), 'utf8'));
  delete event.payload.ai_agent_response.client_metadata.binding_record_id;
  const originalGet = bot.timelineEntriesGet.getMockImplementation()!;
  bot.timelineEntriesGet.mockImplementation(async (request) => {
    if (request.external_ref) {
      if (behavior === 'unsupported query') throw { isAxiosError: true, response: { status: 400 } };
      return { data: { timeline_entry: comment } };
    }
    return originalGet(request);
  });
  await complete([event]);
  expect(comment.body).toContain('GitHub issue #166');
  expect(bot.timelineEntriesList).toHaveBeenCalledWith(expect.objectContaining({ object: issueId, visibility: ['private'] }), { timeout: 10000 });
});

test('logs the failing record operation and HTTP status without response data or credentials', async () => {
  await fetchContext([click('github')]);
  const event = response('message', '{}');
  const originalGet = bot.timelineEntriesGet.getMockImplementation()!;
  bot.timelineEntriesGet.mockImplementation(async (request) => {
    if (request.id === event.payload.ai_agent_response.client_metadata.binding_record_id) throw { isAxiosError: true, response: { status: 503, data: 'private-nr-key' } };
    return originalGet(request);
  });
  bot.timelineEntriesList.mockRejectedValueOnce({ isAxiosError: true, response: { status: 403, data: 'actor-token' } });
  await expect(complete([event])).rejects.toThrow('Check the fixed failure code');
  expect(console.error).toHaveBeenCalledWith('[newrelic-context] analysis:failed code=request_record_read_failed status=403');
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(/private-nr-key|actor-token|bot-token/);
});

const triageGitHub = { status: 'existing', url: 'https://github.com/' + repository + '/issues/42', issue_number: 42 };
const triageCoding = { status: 'assigned', provider: 'copilot', issue_url: triageGitHub.url, issue_number: 42 };
const combinedReport = { status: 'completed', analysis: 'Bounded incident brief. NRAK-secret bot-token', github: triageGitHub, coding: triageCoding };

test('one combined click gathers both windows and runs the GitHub coordinator as the user without storing tokens', async () => {
  const input = click('triage');
  input.input_data.global_values.analysis_agent_id = ''; // Combined mode does not require invoking AG-6.
  await fetchContext([input]);
  expect(HttpClient.prototype.nrql).toHaveBeenCalledTimes(6);
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
  const request = agent.aiAgentEventsExecuteAsync.mock.calls[0][0];
  expect(request.agent).toBe(githubAgentId);
  expect(request.client_metadata).toMatchObject({ connector: 'newrelic-triage-v1', triage: { repository, provider: 'copilot' } });
  expect(client.setupBeta).toHaveBeenCalledWith({ endpoint: 'https://api.devrev.ai', token: 'actor-token' });
  const prompt = request.event.input_message.message;
  const evidence = JSON.parse(prompt.split('\n\nEVIDENCE\n')[1]);
  expect(evidence.windows.map((window: { mode: string }) => window.mode)).toEqual(['alert', 'recent']);
  expect(prompt).toContain('triage_and_fix');
  expect(prompt).toContain('Only after the GitHub issue is verified');
  expect(prompt.length).toBeLessThanOrEqual(16384);
  expect(JSON.stringify(request)).not.toMatch(/private-nr-key|actor-token|bot-token/);
  expect(JSON.stringify([...records.values()])).not.toMatch(/private-nr-key|actor-token|bot-token/);
  expect(comment.body).toContain('triage requested');
});

test('posts one scrubbed combined result with the incident brief and verified issue/assignment', async () => {
  await fetchContext([click('triage')]);
  await complete([response('message', JSON.stringify(combinedReport))]);
  expect(comment.body).toContain('## New Relic incident triage');
  expect(comment.body).toContain('GitHub issue #42');
  expect(comment.body).toContain('GitHub Copilot is assigned');
  expect(comment.body).toContain('Bounded incident brief.');
  expect(comment.body).not.toMatch(/NRAK-secret|bot-token/);
  await complete([response('message', JSON.stringify(combinedReport))]);
  expect(bot.timelineEntriesUpdate).toHaveBeenCalledTimes(1);
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
});

test.each(['github', 'coding'])('preserves completed stages when the combined agent stops at %s', async (stage) => {
  await fetchContext([click('triage')]);
  const report = { status: 'partial', stopped_at: stage, analysis: 'Investigation brief.', ...(stage === 'coding' ? { github: triageGitHub } : {}) };
  await complete([response('message', JSON.stringify(report))]);
  expect(comment.body).toContain('Investigation brief.');
  expect(comment.body).toContain(stage === 'github' ? 'No GitHub issue result was validated' : 'Coding assignment was not validated');
  expect(comment.body).not.toContain('GitHub Copilot is assigned');
});

test.each(['repository', 'provider', 'agent'])('rejects a combined callback with mismatched %s routing', async (field) => {
  await fetchContext([click('triage')]);
  const event = response('message', JSON.stringify(combinedReport));
  if (field === 'repository') event.payload.ai_agent_response.client_metadata.triage.repository = 'other/repo';
  if (field === 'provider') event.payload.ai_agent_response.client_metadata.triage.provider = 'other';
  if (field === 'agent') event.payload.ai_agent_response.agent = agentId;
  await complete([event]).catch(() => undefined);
  expect(bot.timelineEntriesUpdate).not.toHaveBeenCalled();
});

test.each(['repository', 'provider', 'coordinator'])('does not query telemetry or start a combined run with missing/unsupported %s configuration', async (field) => {
  const input = click('triage');
  if (field === 'repository') input.input_data.global_values.github_issue_repository = '';
  if (field === 'coordinator') input.input_data.global_values.github_issue_agent_id = '';
  if (field === 'provider') Object.assign(input.input_data.global_values, { coding_agent_provider: 'unknown' });
  await expect(fetchContext([input])).rejects.toThrow();
  expect(HttpClient.prototype.getIssue).not.toHaveBeenCalled();
  expect(agent.aiAgentEventsExecuteAsync).not.toHaveBeenCalled();
});

test('deduplicates a delivered combined click and accepts a callback after an uncertain start', async () => {
  agent.aiAgentEventsExecuteAsync.mockRejectedValueOnce(new Error('response timeout'));
  await expect(fetchContext([click('triage')])).rejects.toThrow('Could not start or confirm');
  await fetchContext([click('triage')]);
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
  await complete([response('message', JSON.stringify(combinedReport))]);
  expect(comment.body).toContain('GitHub issue #42');
});

test('individual GitHub issue creation can use a completed combined analysis', async () => {
  const body = triageResult(JSON.stringify({ status: 'partial', stopped_at: 'github', analysis: 'Latest combined brief.' }), { repository, provider: 'copilot' }, [])!;
  actor.timelineEntriesList.mockResolvedValueOnce({ data: { timeline_entries: [{ id: issueId + ':comment/triage', object: issueId,
    type: 'timeline_comment', visibility: 'internal', created_by: { id: serviceAccountId },
    external_ref: 'newrelic-triage:' + 'c'.repeat(64), body }] } });
  await fetchContext([click('github')]);
  const input = JSON.parse(agent.aiAgentEventsExecuteAsync.mock.calls[0][0].event.input_message.message.split('\nINPUT\n')[1]);
  expect(input.analysis).toContain('Latest combined brief.');
  expect(input.analysis_comment_id).toBe(issueId + ':comment/triage');
});

test('coding progress consumes the combined GitHub result while Start reuses the reported assignment', async () => {
  const body = triageResult(JSON.stringify(combinedReport), { repository, provider: 'copilot' }, [])!;
  actor.timelineEntriesList.mockResolvedValue({ data: { timeline_entries: [{ id: issueId + ':comment/triage', object: issueId,
    type: 'timeline_comment', visibility: 'internal', created_by: { id: serviceAccountId },
    external_ref: 'newrelic-triage:' + 'c'.repeat(64), body }] } });
  await fetchContext([click('coding')]);
  expect(agent.aiAgentEventsExecuteAsync).not.toHaveBeenCalled();
  await fetchContext([click('coding_status')]);
  const input = JSON.parse(agent.aiAgentEventsExecuteAsync.mock.calls[0][0].event.input_message.message.split('\nINPUT\n')[1]);
  expect(input).toMatchObject({ operation: 'coding_status', issue_number: 42, issue_url: triageGitHub.url });
  expect(HttpClient.prototype.nrql).not.toHaveBeenCalled();
});

test.each([undefined, false, 'true'])('triage keeps acknowledgment opt-in for setting %j', async (value) => {
  const acknowledge = jest.spyOn(HttpClient.prototype, 'acknowledgeIssue').mockResolvedValue('acknowledged');
  const input = click('triage');
  Object.assign(input.input_data.global_values, { acknowledge_on_triage: value });
  await fetchContext([input]);
  expect(acknowledge).not.toHaveBeenCalled();
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
});

test('opted-in triage acknowledges using the same user connection before collecting telemetry and starting the agent', async () => {
  const acknowledge = jest.spyOn(HttpClient.prototype, 'acknowledgeIssue').mockResolvedValue('acknowledged');
  const input = click('triage');
  Object.assign(input.input_data.global_values, { acknowledge_on_triage: true });
  await expect(fetchContext([input])).resolves.toMatchObject({ status: 'success', acknowledgment_status: 'acknowledged' });
  expect(acknowledge).toHaveBeenCalledWith('123', issue.issueId, issue.createdAt);
  expect(acknowledge.mock.invocationCallOrder[0]).toBeLessThan((HttpClient.prototype.nrql as jest.Mock).mock.invocationCallOrder[0]);
  expect(actor.timelineEntriesCreate).toHaveBeenCalledWith(expect.objectContaining({
    object: issueId, visibility: 'internal', body: expect.stringContaining('acknowledgment was verified'),
  }), { timeout: 10000 });
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(agent.aiAgentEventsExecuteAsync.mock.calls)).not.toMatch(/private-nr-key|actor-token|bot-token|acknowledgment_status/);
  await complete([response('message', JSON.stringify(combinedReport))]);
  expect(comment.body).toContain('GitHub issue #42');
  expect(acknowledge).toHaveBeenCalledTimes(1); // No key reuse or acknowledgment from the asynchronous callback.
});

test.each(['rejected', 'unconfirmed'] as const)('an acknowledgment that is %s does not stop opted-in triage', async (code) => {
  jest.spyOn(HttpClient.prototype, 'acknowledgeIssue').mockRejectedValue(new NewRelicAcknowledgmentError(code));
  const input = click('triage');
  Object.assign(input.input_data.global_values, { acknowledge_on_triage: true });
  await expect(fetchContext([input])).resolves.toMatchObject({ status: 'success', acknowledgment_status: code });
  expect(actor.timelineEntriesCreate).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining(code === 'rejected' ? 'did not accept' : 'could not be confirmed') }), { timeout: 10000 });
  expect(HttpClient.prototype.nrql).toHaveBeenCalledTimes(6);
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
  expect(bot.timelineEntriesCreate).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('triage requested') }), { timeout: 10000 });
});

test('triage still starts if its acknowledgment result cannot be posted', async () => {
  jest.spyOn(HttpClient.prototype, 'acknowledgeIssue').mockResolvedValue('acknowledged');
  actor.timelineEntriesCreate.mockRejectedValueOnce(new Error('private-nr-key actor-token'));
  const input = click('triage');
  Object.assign(input.input_data.global_values, { acknowledge_on_triage: true });
  await expect(fetchContext([input])).resolves.toMatchObject({ status: 'success', detail: expect.stringContaining('could not be posted') });
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledWith('[newrelic-context] acknowledgment:report_failed');
});

test.each(['evidence', 'recent_evidence', 'github', 'coding', 'coding_status'])('the acknowledgment setting does not make the %s action acknowledge', async (mode) => {
  const acknowledge = jest.spyOn(HttpClient.prototype, 'acknowledgeIssue').mockResolvedValue('acknowledged');
  const input = click(mode);
  Object.assign(input.input_data.global_values, { acknowledge_on_triage: true });
  // Some standalone handoffs need a previous result; their preflight can reject,
  // but neither a successful read-only action nor a rejected handoff may write.
  await fetchContext([input]).catch(() => undefined);
  expect(acknowledge).not.toHaveBeenCalled();
});

test.each(['alert', 'recent'])('the %s analysis action acknowledges only after the user explicitly starts analysis with the setting enabled', async (mode) => {
  const acknowledge = jest.spyOn(HttpClient.prototype, 'acknowledgeIssue').mockResolvedValue('acknowledged');
  const input = click(mode);
  Object.assign(input.input_data.global_values, { acknowledge_on_triage: true });
  await expect(fetchContext([input])).resolves.toMatchObject({ acknowledgment_status: 'acknowledged' });
  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect(acknowledge).toHaveBeenCalledWith('123', issue.issueId, issue.createdAt);
  expect(acknowledge.mock.invocationCallOrder[0]).toBeLessThan((HttpClient.prototype.nrql as jest.Mock).mock.invocationCallOrder[0]);
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
  expect(console.info).toHaveBeenCalledWith(`[newrelic-context] acknowledgment:requested action=${mode}`);
});

test.each(['alert', 'recent'])('the %s analysis action keeps acknowledgment disabled by default', async (mode) => {
  const acknowledge = jest.spyOn(HttpClient.prototype, 'acknowledgeIssue').mockResolvedValue('acknowledged');
  await fetchContext([click(mode)]);
  expect(acknowledge).not.toHaveBeenCalled();
});

test('an invalid analysis configuration cannot acknowledge before analysis starts', async () => {
  const acknowledge = jest.spyOn(HttpClient.prototype, 'acknowledgeIssue').mockResolvedValue('acknowledged');
  const input = click();
  Object.assign(input.input_data.global_values, { acknowledge_on_triage: true, analysis_agent_id: '' });
  await expect(fetchContext([input])).rejects.toThrow();
  expect(acknowledge).not.toHaveBeenCalled();
});

test('invalid triage configuration rejects before any acknowledgment', async () => {
  const acknowledge = jest.spyOn(HttpClient.prototype, 'acknowledgeIssue').mockResolvedValue('acknowledged');
  const input = click('triage');
  Object.assign(input.input_data.global_values, { acknowledge_on_triage: true, github_issue_repository: '' });
  await expect(fetchContext([input])).rejects.toThrow();
  expect(acknowledge).not.toHaveBeenCalled();
  expect(actor.timelineEntriesCreate).not.toHaveBeenCalled();
});

function investigationClick(mode = 'github') {
  const input = click(mode);
  Object.assign(input.input_data.global_values, { investigate_on_github_issue: true });
  return input;
}
function investigationResponse(message = JSON.stringify(triageGitHub)) {
  const event = response('message', message);
  Object.assign(event.input_data.global_values, { investigate_on_github_issue: true });
  return event;
}

test.each(['created', 'existing'])('marks the source investigating after a validated %s GitHub result using the reserved actor connection', async (status) => {
  const mark = jest.spyOn(HttpClient.prototype, 'markIssueInvestigating').mockResolvedValue('investigating');
  await fetchContext([investigationClick()]);
  expect(mark).not.toHaveBeenCalled();
  const metadata = agent.aiAgentEventsExecuteAsync.mock.calls[0][0].client_metadata;
  expect(metadata.investigation_requested).toBe(true);
  expect(metadata.investigation_record_id).toMatch(/:comment\/record-/);
  expect(JSON.stringify(metadata)).not.toMatch(/user-1|private-nr-key|actor-token|bot-token/);
  const saved = [...records.values()].find((entry) => entry.external_ref.startsWith('newrelic-investigation-request:'))!;
  expect(JSON.parse(saved.body)).toMatchObject({ actor_id: 'user-1', external_record_id: '123:source-issue' });
  const event = investigationResponse(JSON.stringify({ ...triageGitHub, status }));
  Object.assign(event.payload.ai_agent_response.client_metadata, { actor_id: 'attacker', api_key: 'untrusted-key' });
  await complete([event]);
  expect(agent.snapInsResources).toHaveBeenCalledWith({ id: snapInId, user: 'user-1' }, { timeout: 10000 });
  expect(client.setupBeta).toHaveBeenLastCalledWith({ endpoint: 'https://api.devrev.ai', token: 'bot-token' });
  expect(mark).toHaveBeenCalledWith('123', issue.issueId, issue.createdAt);
  expect(bot.timelineEntriesUpdate.mock.invocationCallOrder[0]).toBeLessThan(mark.mock.invocationCallOrder[0]);
  expect(comment.body).toContain('GitHub issue #42');
  expect([...investigationReports.values()][0].body).toContain('now marked as investigating');
  expect(JSON.stringify([...investigationReports.values()])).not.toMatch(/private-nr-key|actor-token|bot-token|untrusted-key/);
});

test.each(['completed', 'partial-coding', 'partial-github'])('combined %s report updates investigation only if its winning result contains a GitHub issue', async (kind) => {
  const mark = jest.spyOn(HttpClient.prototype, 'markIssueInvestigating').mockResolvedValue('investigating');
  await fetchContext([investigationClick('triage')]);
  const report = kind === 'completed' ? combinedReport : { status: 'partial', analysis: 'A factual brief.',
    stopped_at: kind === 'partial-coding' ? 'coding' : 'github', ...(kind === 'partial-coding' ? { github: triageGitHub } : {}) };
  await complete([investigationResponse(JSON.stringify(report))]);
  expect(mark).toHaveBeenCalledTimes(kind === 'partial-github' ? 0 : 1);
  expect(comment.body).toContain(kind === 'partial-github' ? 'No GitHub issue result' : 'GitHub issue #42');
});

test.each(['invalid report', 'disabled', 'not requested', 'expired'])('does not mark investigating for %s', async (failure) => {
  const mark = jest.spyOn(HttpClient.prototype, 'markIssueInvestigating').mockResolvedValue('investigating');
  await fetchContext([failure === 'not requested' ? click('github') : investigationClick()]);
  const event = investigationResponse(failure === 'invalid report' ? '{"status":"error"}' : undefined);
  if (failure === 'disabled') Object.assign(event.input_data.global_values, { investigate_on_github_issue: false });
  if (failure === 'expired') comment.created_date = new Date(now - 31 * 60000).toISOString();
  await complete([event]);
  expect(mark).not.toHaveBeenCalled();
  expect(agent.snapInsResources).not.toHaveBeenCalled();
});

test.each(['record mismatch', 'wrong actor record', 'source mismatch', 'connection missing', 'connection expired', 'mutation failed'])('preserves the GitHub result and reports investigation failure for %s', async (failure) => {
  const mark = jest.spyOn(HttpClient.prototype, 'markIssueInvestigating').mockResolvedValue('investigating');
  await fetchContext([investigationClick()]);
  const event = investigationResponse();
  const reserved = records.get([...records.keys()].find((key) => key.startsWith('newrelic-investigation-request:'))!)!;
  if (failure === 'record mismatch') event.payload.ai_agent_response.client_metadata.investigation_record_id = issueId + ':comment/wrong-record';
  if (failure === 'wrong actor record') reserved.created_by = { id: 'other-bot' };
  if (failure === 'source mismatch') reserved.body = JSON.stringify({ ...JSON.parse(reserved.body), external_record_id: '999:another-source' });
  if (failure === 'connection missing') agent.snapInsResources.mockResolvedValue({ data: { keyrings: {} } });
  if (failure === 'connection expired') agent.snapInsResources.mockResolvedValue({ data: { keyrings: { newrelic_context: { is_expired: true, secret: 'private-nr-key' } } } });
  if (failure === 'mutation failed') mark.mockRejectedValue(new NewRelicInvestigationError('read_back_pending'));
  await expect(complete([event])).resolves.toBeUndefined();
  expect(comment.body).toContain('GitHub issue #42');
  expect([...investigationReports.values()][0].body).toContain('could not be confirmed');
  if (failure !== 'mutation failed') expect(mark).not.toHaveBeenCalled();
  expect(JSON.stringify([...records.values()])).not.toMatch(/private-nr-key|actor-token|bot-token/);
  expect(JSON.stringify([...investigationReports.values()])).not.toMatch(/private-nr-key|actor-token|bot-token/);
});

test('duplicate callbacks reuse the investigation outcome without looking up credentials or updating New Relic again', async () => {
  const mark = jest.spyOn(HttpClient.prototype, 'markIssueInvestigating').mockResolvedValue('investigating');
  await fetchContext([investigationClick()]);
  const event = investigationResponse();
  await complete([event]);
  await complete([event]);
  expect(mark).toHaveBeenCalledTimes(1);
  expect(agent.snapInsResources).toHaveBeenCalledTimes(1);
  expect(investigationReports.size).toBe(1);
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
});

test('a failed investigation report can retry after the GitHub result was already published, without a second New Relic write', async () => {
  const mark = jest.spyOn(HttpClient.prototype, 'markIssueInvestigating').mockResolvedValue('investigating');
  await fetchContext([investigationClick()]);
  const original = bot.timelineEntriesCreate.getMockImplementation()!;
  let fail = true;
  bot.timelineEntriesCreate.mockImplementation(async (request) => {
    if (fail && request.external_ref.startsWith('newrelic-investigation-report:')) { fail = false; throw new Error('bot-token private-nr-key'); }
    return original(request);
  });
  const event = investigationResponse();
  await expect(complete([event])).rejects.toThrow('completion failed');
  expect(comment.body).toContain('GitHub issue #42');
  await expect(complete([event])).resolves.toBeUndefined();
  expect(mark).toHaveBeenCalledTimes(1);
  expect(agent.snapInsResources).toHaveBeenCalledTimes(1);
  expect(bot.timelineEntriesUpdate).toHaveBeenCalledTimes(1);
  expect(investigationReports.size).toBe(1);
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(/private-nr-key|bot-token/);
});

test('investigation reservation failure leaves the GitHub workflow usable and cannot select a callback user connection', async () => {
  const mark = jest.spyOn(HttpClient.prototype, 'markIssueInvestigating').mockResolvedValue('investigating');
  const original = bot.timelineEntriesCreate.getMockImplementation()!;
  bot.timelineEntriesCreate.mockImplementation(async (request) => {
    if (request.external_ref.startsWith('newrelic-investigation-request:')) throw new Error('bot-token');
    return original(request);
  });
  await expect(fetchContext([investigationClick()])).resolves.toMatchObject({ status: 'success' });
  await complete([investigationResponse()]);
  expect(comment.body).toContain('GitHub issue #42');
  expect([...investigationReports.values()][0].body).toContain('request_invalid');
  expect(mark).not.toHaveBeenCalled();
  expect(agent.snapInsResources).not.toHaveBeenCalled();
});

test('an error that wins terminal arbitration never triggers investigation from a later successful agent reply', async () => {
  const mark = jest.spyOn(HttpClient.prototype, 'markIssueInvestigating').mockResolvedValue('investigating');
  await fetchContext([investigationClick()]);
  const failure = investigationResponse();
  failure.payload.ai_agent_response.agent_response = 'error';
  await complete([failure]);
  await complete([investigationResponse()]);
  expect(comment.body).toContain('GitHub issue request unavailable');
  expect(mark).not.toHaveBeenCalled();
  expect(agent.snapInsResources).not.toHaveBeenCalled();
});

test('an API-confirmed acknowledgment with inconclusive read-back remains a successful triage step', async () => {
  jest.spyOn(HttpClient.prototype, 'acknowledgeIssue').mockResolvedValue('acknowledged_by_api');
  const input = click('triage');
  Object.assign(input.input_data.global_values, { acknowledge_on_triage: true });
  await expect(fetchContext([input])).resolves.toMatchObject({ status: 'success', acknowledgment_status: 'acknowledged_by_api' });
  const body = actor.timelineEntriesCreate.mock.calls[0][0].body;
  expect(body).toContain('New Relic confirmed the acknowledgment request');
  expect(body).not.toContain('could not be confirmed');
  expect(agent.aiAgentEventsExecuteAsync).toHaveBeenCalledTimes(1);
});

test.each([
  ['operation_unavailable', undefined, 'did not expose the Mark as investigating operation'],
  ['validation_error', undefined, 'rejected the query against its API schema'],
  ['access_denied', undefined, 'denied API access'],
  ['http_error', 403, 'denied API access'],
] as const)('reports safe investigation guidance for %s while preserving the GitHub result', async (reason, status, text) => {
  jest.spyOn(HttpClient.prototype, 'markIssueInvestigating').mockRejectedValue(new NewRelicInvestigationError('mutation_unconfirmed', reason, status));
  await fetchContext([investigationClick()]);
  await complete([investigationResponse()]);
  expect(comment.body).toContain('GitHub issue #42');
  const body = [...investigationReports.values()][0].body;
  expect(body).toContain(text);
  expect(body).toContain('mutation_unconfirmed/' + reason);
  if (status) expect(body).toContain('HTTP ' + status);
  expect(body).not.toMatch(/private-nr-key|actor-token|bot-token/);
  expect(console.info).toHaveBeenCalledWith('[newrelic-context] investigation:unconfirmed code=mutation_unconfirmed reason=' + reason + (status ? ' status=' + status : ''));
});
