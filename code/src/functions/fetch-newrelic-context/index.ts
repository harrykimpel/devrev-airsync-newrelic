import { createHash } from 'crypto';
import { client, publicSDK } from '@devrev/typescript-sdk';
import axios from 'axios';

import { HttpClient, NewRelicApiError } from '../external-system/http-client';
import { issuePermalink, parseIssueReference } from '../external-system/links';
import { planContext, QueryResult, renderContext, traceSpansQuery } from './context';

interface ContextEvent {
  payload: { action: { id: string; value: string }; context: { object_id: string }; request_id: string };
  context: { secrets: { actor_session_token: string }; snap_in_id: string };
  execution_metadata: { devrev_endpoint: string };
  input_data: { keyrings?: Record<string, string>; resources?: { keyrings?: Record<string, { secret?: string } | string> } };
}

function validateEvent(input: unknown): ContextEvent {
  const event = input as ContextEvent | undefined;
  if (!event?.payload?.context?.object_id || !event.payload.request_id || !event.context?.snap_in_id ||
    !event.context.secrets?.actor_session_token || !event.execution_metadata?.devrev_endpoint || !event.input_data ||
    event.payload.action?.id !== 'fetch_newrelic_context' || !['alert', 'recent'].includes(event.payload.action.value)) {
    throw new Error('Run Fetch New Relic context from a DevRev issue while signed in.');
  }
  return event;
}

function devRevFailure(operation: string, error: unknown): Error {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  // SDK errors, like Axios errors, can contain authentication headers. Never serialize them.
  return new Error(`DevRev ${operation} failed (${status ?? 'request error'}). Check issue access and grant the issue:read and comment:write action permissions.`);
}

async function handleEvent(input: unknown) {
  const event = validateEvent(input);
  const resource = event.input_data.resources?.keyrings?.newrelic_context;
  const key = event.input_data.keyrings?.newrelic_context ?? (typeof resource === 'string' ? resource : resource?.secret);
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('Select your New Relic context connection in the snap-in configuration (user connection). Use a user API key with access to this alert account.');
  }
  const actorToken = event.context.secrets.actor_session_token;
  // Both reads and writes run as the clicking user. Never fall back to a more privileged bot.
  const devrev = client.setup({ endpoint: event.execution_metadata.devrev_endpoint, token: actorToken });
  let work: publicSDK.Work;
  try {
    work = (await devrev.worksGet({ id: event.payload.context.object_id }, { timeout: 10000 })).data.work;
  } catch (error) { throw devRevFailure('works.get', error); }
  if (work.type !== 'issue') throw new Error('Fetch New Relic context is available only on issues.');
  const reference = work.sync_metadata?.external_reference ?? work.body?.match(/\[Open in New Relic\]\(<([^>]+)>\)/)?.[1];
  const source = parseIssueReference(reference ?? '');
  const recordId = work.sync_metadata?.external_record_id;
  if (recordId && recordId !== `${source.accountId}:${source.issueId}`) throw new Error('The source link does not match this issue’s AirSync record ID. Re-sync the issue.');
  const newrelic = new HttpClient({ org_id: source.region, key }, 10000);
  const issue = await newrelic.getIssue(source.accountId, source.issueId, Date.parse(work.created_date ?? ''));
  const plan = planContext(issue, event.payload.action.value as 'alert' | 'recent', Date.now());
  // Three independent, five-second NRQL queries; failures remain visible beside successful sections.
  const results: QueryResult[] = await Promise.all(plan.queries.map(async (query) => {
    try { return { ...query, rows: await newrelic.nrql(source.accountId, query.query) }; }
    catch (error) {
      return { ...query, error: error instanceof NewRelicApiError ? error.message : 'Query failed. Check New Relic permissions and retry.' };
    }
  }));
  const spans = traceSpansQuery(plan, results[2]?.rows ?? []);
  if (spans) {
    try { results.push({ ...spans, rows: await newrelic.nrql(source.accountId, spans.query) }); }
    catch (error) { results.push({ ...spans, error: error instanceof NewRelicApiError ? error.message : 'Span details unavailable. Check New Relic permissions and retry.' }); }
  }
  const body = renderContext(issuePermalink(source.accountId, source.issueId, source.region), source.accountId, plan, results, [key, actorToken]);
  const requestHash = createHash('sha256').update(`${event.context.snap_in_id}:${event.payload.request_id}`).digest('hex');
  const externalRef = `newrelic-context:${requestHash}`;
  try {
    await devrev.timelineEntriesCreate({
      object: work.id,
      type: publicSDK.TimelineEntriesCreateRequestType.TimelineComment,
      visibility: publicSDK.TimelineEntryVisibility.Internal,
      body,
      external_ref: externalRef,
    }, { timeout: 10000 });
  } catch (error) {
    // A conflict is success only if the same request's internal comment actually exists.
    // Some API versions report duplicate external references as a bad request.
    let duplicate = false;
    if (axios.isAxiosError(error) && [400, 409].includes(error.response?.status ?? 0)) {
      try {
        const recent = await devrev.timelineEntriesList({ object: work.id, mode: publicSDK.ListMode.Before, limit: 100 }, { timeout: 10000 });
        duplicate = recent.data.timeline_entries.some((entry) => entry.type === 'timeline_comment' &&
          entry.external_ref === externalRef && entry.visibility === 'internal');
      } catch { /* Preserve a sanitized failure if duplicate delivery cannot be verified. */ }
    }
    if (!duplicate) throw devRevFailure('timeline-entries.create', error);
  }
  return { status: 'success', detail: 'New Relic context posted to the issue’s internal discussion.' };
}

export default async function run(events: unknown[]) {
  if (events.length !== 1) throw new Error('Expected one issue action event.');
  return handleEvent(events[0]);
}
