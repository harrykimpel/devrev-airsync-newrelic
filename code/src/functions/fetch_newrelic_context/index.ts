import { createHash, randomUUID } from 'crypto';
import { client, publicSDK } from '@devrev/typescript-sdk';
import axios from 'axios';

import { HttpClient, NewRelicApiError } from '../external-system/http-client';
import { issuePermalink, parseIssueReference } from '../external-system/links';
import { NewRelicIssue } from '../external-system/types';
import { AnalysisError, analysisPrompt, configuredAgent, RESPONSE_SOURCE, Snapshot, startAnalysis } from './analysis';
import { planContext, QueryResult, renderContext, traceSpansQuery } from './context';
import { handoffGitHub } from './github-handoff';
import { handoffCoding } from './coding-handoff';
import { triageConfiguration, triagePrompt } from './triage-handoff';
import { acknowledgeSource } from './acknowledgment';

interface ContextEvent {
  payload: { action: { id: string; value: string; timestamp?: string | number }; context: { object_id: string; parent_core_object_id?: string }; request_id: string; actor_id?: string };
  context: { secrets: { actor_session_token: string; service_account_token?: string }; snap_in_id: string; service_account_id?: string };
  execution_metadata: { devrev_endpoint: string; request_id?: string };
  input_data?: { global_values?: Record<string, unknown>; event_sources?: Record<string, string>; keyrings?: Record<string, string>; resources?: { keyrings?: Record<string, { secret?: string; is_expired?: boolean } | string> } };
}

class ContextActionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function actionTimestamp(value: unknown): string | undefined {
  // The browser sends ISO timestamps; Snap-kit events can use Unix seconds.
  const milliseconds = typeof value === 'number' && Number.isFinite(value)
    ? (value < 1e11 ? value * 1000 : value)
    : typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 8640000000000000) return undefined;
  return new Date(Math.round(milliseconds)).toISOString();
}

function requestIdentity(event: ContextEvent, issueId: string): string {
  if (nonEmpty(event.payload.request_id)) return event.payload.request_id;
  const timestamp = actionTimestamp(event.payload.action.timestamp);
  if (timestamp) {
    // A retry can receive a different execution ID. Keep the original click's
    // identity stable, scoped to its issue, actor and requested window.
    const actorId = nonEmpty(event.payload.actor_id) ? event.payload.actor_id : null;
    return `click:${JSON.stringify([issueId, actorId, event.payload.action.id, event.payload.action.value, timestamp])}`;
  }
  if (nonEmpty(event.execution_metadata.request_id)) return event.execution_metadata.request_id;
  // Correlation metadata is not authorization. Its absence must not block an
  // otherwise valid action. Without it we cannot deduplicate across deliveries.
  console.info('[newrelic-context] request:generated');
  return `generated:${randomUUID()}`;
}

function validateEvent(input: unknown): ContextEvent {
  const event = input as ContextEvent | undefined;
  const objectId = event?.payload?.context?.object_id;
  const parentId = event?.payload?.context?.parent_core_object_id;
  const issueId = nonEmpty(objectId) ? objectId : parentId;
  if (!nonEmpty(issueId)) throw new ContextActionError('missing_issue', 'Run this action from a DevRev issue using New Relic incident triage.');
  if (nonEmpty(objectId) && nonEmpty(parentId) && objectId !== parentId) {
    throw new ContextActionError('conflicting_issue', 'The action contains conflicting issue IDs. Refresh the issue and retry.');
  }
  if (!nonEmpty(event?.context?.snap_in_id)) throw new ContextActionError('missing_installation', 'The action is missing its snap-in installation ID.');
  if (!nonEmpty(event?.context?.secrets?.actor_session_token)) throw new ContextActionError('missing_actor_token', 'Sign in and grant the issue:read impersonation permission for this snap-in.');
  if (!nonEmpty(event?.execution_metadata?.devrev_endpoint)) throw new ContextActionError('missing_endpoint', 'The action is missing its DevRev endpoint.');
  if (event?.payload?.action?.id !== 'fetch_newrelic_context' || !['alert', 'recent', 'evidence', 'recent_evidence', 'github', 'coding', 'coding_status', 'triage', 'acknowledge'].includes(event.payload.action.value)) {
    throw new ContextActionError('invalid_action', 'Run this action from New Relic incident triage on a DevRev issue while signed in.');
  }
  return { ...event, payload: { ...event.payload, context: { object_id: issueId }, request_id: requestIdentity(event, issueId) } };
}

async function contextKey(event: ContextEvent): Promise<string> {
  const resource = event.input_data?.resources?.keyrings?.newrelic_context;
  const key = event.input_data?.keyrings?.newrelic_context ?? (typeof resource === 'string' ? resource : resource?.secret);
  if (resource && typeof resource === 'object' && resource.is_expired) {
    throw new ContextActionError('connection_expired', 'Reauthorize your New Relic connection in the snap-in’s My Settings.');
  }
  if (nonEmpty(key)) return key;

  // User keyrings are separate snap-in resources and need not be injected into the event.
  // This API requires the snap-in's service account. Fetch only the clicking user's
  // resource on this installation; issue reads/writes still use the actor token.
  if (!nonEmpty(event.payload.actor_id) || !nonEmpty(event.context.secrets.service_account_token)) {
    throw new ContextActionError('missing_connection_context', 'The action cannot load your user connection: its actor ID or snap-in service token is missing.');
  }
  console.info('[newrelic-context] connection:lookup');
  const resources = client.setupBeta({ endpoint: event.execution_metadata.devrev_endpoint, token: event.context.secrets.service_account_token });
  let connection;
  try {
    connection = (await resources.snapInsResources({ id: event.context.snap_in_id, user: event.payload.actor_id }, { timeout: 10000 })).data.keyrings?.newrelic_context;
  } catch {
    // SDK/Axios errors can contain tokens and response bodies. Do not log or rethrow them.
    throw new ContextActionError('connection_lookup_failed', 'Could not load your New Relic connection. Open Settings → Integrations → Snap-ins → New Relic → Configure → My Settings, enable it for yourself, select a connection, and save.');
  }
  if (connection?.is_expired) throw new ContextActionError('connection_expired', 'Reauthorize your New Relic connection in the snap-in’s My Settings.');
  const secret = connection?.secret;
  if (!nonEmpty(secret)) {
    throw new ContextActionError('connection_missing', 'Select a New Relic connection in the snap-in’s My Settings, turn on Enable for me, and save. Use a user API key with access to this alert account.');
  }
  return secret;
}

function devRevFailure(operation: string, error: unknown): Error {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  // SDK errors, like Axios errors, can contain authentication headers. Never serialize them.
  return new Error(`DevRev ${operation} failed (${status ?? 'request error'}). Check issue access and grant the issue:read impersonation permission; timeline entries use the parent issue's permissions.`);
}

async function collectSnapshot(newrelic: HttpClient, accountId: string, issue: NewRelicIssue, mode: 'alert' | 'recent', now: number): Promise<Snapshot> {
  const plan = planContext(issue, mode, now);
  // Three independent, five-second NRQL queries; failures remain visible beside successful sections.
  const results: QueryResult[] = await Promise.all(plan.queries.map(async (query) => {
    try { return { ...query, rows: await newrelic.nrql(accountId, query.query) }; }
    catch (error) {
      return { ...query, error: error instanceof NewRelicApiError ? error.message : 'Query failed. Check New Relic permissions and retry.' };
    }
  }));
  const spans = traceSpansQuery(plan, results[2]?.rows ?? []);
  if (spans) {
    try { results.push({ ...spans, rows: await newrelic.nrql(accountId, spans.query) }); }
    catch (error) { results.push({ ...spans, error: error instanceof NewRelicApiError ? error.message : 'Span details unavailable. Check New Relic permissions and retry.' }); }
  }
  return { mode, plan, results };
}

async function handleEvent(input: unknown) {
  const event = validateEvent(input);
  console.info('[newrelic-context] fetch:validated');
  const handoff = ['github', 'coding', 'coding_status'].includes(event.payload.action.value);
  const key = handoff ? '' : await contextKey(event);
  if (key) console.info('[newrelic-context] connection:ready');
  const actorToken = event.context.secrets.actor_session_token;
  // Authorize the issue as the clicking user before any telemetry or bot writes.
  const devrev = client.setup({ endpoint: event.execution_metadata.devrev_endpoint, token: actorToken });
  let work: publicSDK.Work;
  try {
    work = (await devrev.worksGet({ id: event.payload.context.object_id }, { timeout: 10000 })).data.work;
  } catch (error) { throw devRevFailure('works.get', error); }
  console.info('[newrelic-context] issue:loaded');
  if (work.type !== 'issue' || (work.id !== event.payload.context.object_id && work.display_id !== event.payload.context.object_id)) throw new Error('New Relic incident triage is available only on the selected issue.');
  const reference = work.sync_metadata?.external_reference ?? work.body?.match(/\[Open in New Relic\]\(<([^>]+)>\)/)?.[1];
  const source = parseIssueReference(reference ?? '');
  const recordId = work.sync_metadata?.external_record_id;
  if (recordId && recordId !== `${source.accountId}:${source.issueId}`) throw new Error('The source link does not match this issue’s AirSync record ID. Re-sync the issue.');
  const sourceUrl = issuePermalink(source.accountId, source.issueId, source.region);
  const requestHash = createHash('sha256').update(`${event.context.snap_in_id}:${event.payload.request_id}`).digest('hex');
  const evidenceOnly = ['evidence', 'recent_evidence'].includes(event.payload.action.value);
  const acknowledgmentOnly = event.payload.action.value === 'acknowledge';
  const github = event.payload.action.value === 'github';
  const triage = event.payload.action.value === 'triage' ? triageConfiguration(event.input_data?.global_values, work.id) : undefined;
  const mode = ['recent', 'recent_evidence'].includes(event.payload.action.value) ? 'recent' : 'alert';
  const agentId = triage?.agentId ?? (evidenceOnly || handoff || acknowledgmentOnly ? '' : configuredAgent(event.input_data?.global_values?.analysis_agent_id, work.id));
  const eventSource = event.input_data?.event_sources?.[RESPONSE_SOURCE];
  const serviceToken = event.context.secrets.service_account_token;
  const serviceAccountId = event.context.service_account_id;
  if (!evidenceOnly && !acknowledgmentOnly && (!nonEmpty(eventSource) || !nonEmpty(serviceToken) || !nonEmpty(serviceAccountId))) {
    throw new AnalysisError('missing_analysis_context', 'The snap-in is missing its analysis response event source or service context. Upgrade the current installation with the analysis manifest.');
  }
  const investigation = (github || triage) && event.input_data?.global_values?.investigate_on_github_issue === true
    ? { actorId: event.payload.actor_id ?? '', createdAt: Date.parse(work.created_date ?? ''), externalRecordId: recordId ?? '' } : undefined;
  if (github) {
    return handoffGitHub({ endpoint: event.execution_metadata.devrev_endpoint, actorToken,
      serviceToken: serviceToken!, serviceAccountId: serviceAccountId!, eventSource: eventSource!,
      snapInId: event.context.snap_in_id, issue: work, sourceUrl, requestHash,
      agentValue: event.input_data?.global_values?.github_issue_agent_id,
      repositoryValue: event.input_data?.global_values?.github_issue_repository, investigation });
  }
  if (handoff) {
    const globals = event.input_data?.global_values;
    return handoffCoding({ endpoint: event.execution_metadata.devrev_endpoint, actorToken,
      serviceToken: serviceToken!, serviceAccountId: serviceAccountId!, eventSource: eventSource!,
      snapInId: event.context.snap_in_id, issue: work, sourceUrl, requestHash,
      operation: event.payload.action.value === 'coding' ? 'start' : 'status',
      agentValue: globals?.coding_agent_id || globals?.github_issue_agent_id,
      repositoryValue: globals?.github_issue_repository, providerValue: globals?.coding_agent_provider,
      baseBranchValue: globals?.coding_agent_base_branch });
  }
  const newrelic = new HttpClient({ org_id: source.region, key }, 10000);
  const startsAnalysis = ['alert', 'recent', 'triage'].includes(event.payload.action.value);
  const shouldAcknowledge = acknowledgmentOnly || (startsAnalysis && event.input_data?.global_values?.acknowledge_on_triage === true);
  if (shouldAcknowledge && recordId !== `${source.accountId}:${source.issueId}`) {
    throw new Error('Acknowledgment requires an imported issue whose AirSync record ID matches its New Relic source. Re-sync the issue.');
  }
  if (shouldAcknowledge) console.info(`[newrelic-context] acknowledgment:requested action=${event.payload.action.value}`);
  const acknowledgment = shouldAcknowledge
    ? await acknowledgeSource({ newrelic, devrev, issueId: work.id, accountId: source.accountId, sourceIssueId: source.issueId,
      createdAt: Date.parse(work.created_date ?? ''), sourceUrl, requestHash }) : undefined;
  if (acknowledgmentOnly) {
    return { status: 'success', acknowledgment_status: acknowledgment!.outcome, detail: acknowledgment!.detail };
  }
  const issue = await newrelic.getIssue(source.accountId, source.issueId, Date.parse(work.created_date ?? ''));
  const now = Date.now();
  if (!evidenceOnly) {
    const snapshots = await Promise.all((['alert', 'recent'] as const).map((window) => collectSnapshot(newrelic, source.accountId, issue, window, now)));
    const result = await startAnalysis({ endpoint: event.execution_metadata.devrev_endpoint, actorToken,
      serviceToken: serviceToken!, serviceAccountId: serviceAccountId!, eventSource: eventSource!,
      snapInId: event.context.snap_in_id, issueId: work.id, agentId, requestHash, sourceUrl,
      ...(triage ? { triage: triage.binding } : {}),
      investigation,
      prompt: triage ? triagePrompt({ title: work.title ?? '', issueId: work.id, sourceUrl, issue, snapshots, requestHash,
        binding: triage.binding, baseRef: triage.baseRef, secrets: [key, actorToken, serviceToken!] })
        : analysisPrompt(work.title ?? '', sourceUrl, issue, snapshots, mode, [key, actorToken, serviceToken!]),
    });
    return acknowledgment ? { ...result, acknowledgment_status: acknowledgment.outcome, detail: result.detail + ' ' + acknowledgment.detail } : result;
  }
  const { plan, results } = await collectSnapshot(newrelic, source.accountId, issue, mode, now);
  const body = renderContext(sourceUrl, source.accountId, plan, results, [key, actorToken]);
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
  console.info('[newrelic-context] fetch:start');
  try {
    if (!Array.isArray(events) || events.length !== 1) throw new ContextActionError('invalid_batch', 'Expected one issue action event.');
    const result = await handleEvent(events[0]);
    console.info('[newrelic-context] fetch:complete');
    return result;
  } catch (error) {
    // Only fixed, locally assigned codes are logged, never event data or raw errors.
    console.error(`[newrelic-context] fetch:failed code=${error instanceof ContextActionError || error instanceof AnalysisError ? error.code : 'request_failed'}`);
    throw error;
  }
}
