import { createHash } from 'crypto';
import { client, publicSDK } from '@devrev/typescript-sdk';

import { HttpClient, NewRelicInvestigationError } from '../external-system/http-client';
import { parseIssueReference } from '../external-system/links';
import { persistRequestRecord, readRequestRecord, RequestRecordError } from './request-record';

export interface InvestigationRequest { actorId: string; createdAt: number; externalRecordId: string }
interface RequestContext {
  bot: ReturnType<typeof client.setup>; botId: string; issueId: string; commentId: string;
  requestReference: string; snapInId: string; sourceUrl: string;
}
export class InvestigationCompletionError extends Error {
  constructor(readonly code: 'investigation_result_failed' | 'investigation_report_failed') { super('Could not complete the New Relic investigation report.'); }
}
const reference = (kind: string, options: RequestContext) => 'newrelic-investigation-' + kind + ':' +
  createHash('sha256').update(options.requestReference + ':' + options.commentId).digest('hex');

/** Save only the initiating identity and imported source binding, never credentials. */
export async function reserveInvestigation(options: RequestContext & { request: InvestigationRequest }): Promise<string> {
  const body = JSON.stringify({ version: 1, snap_in_id: options.snapInId, source_url: options.sourceUrl,
    actor_id: options.request.actorId, created_at: options.request.createdAt, external_record_id: options.request.externalRecordId });
  const saved = await persistRequestRecord({ ...options, reference: reference('request', options), body });
  if (saved.body !== body) throw new InvestigationCompletionError('investigation_result_failed');
  return saved.id;
}

const prefix = '## New Relic investigation status\n\n';
const statuses = {
  investigating: 'The source New Relic issue is now marked as investigating. This was verified by reading its investigation timestamp.',
  already_investigating: 'The source New Relic issue was already marked as investigating. No investigation update was sent.',
  closed: 'The source New Relic issue is already closed. No investigation update was sent.',
};

async function perform(options: RequestContext & { endpoint: string; token: string; recordId?: string }): Promise<string> {
  let stage: 'request_invalid' | 'connection_unavailable' | 'connection_expired' | 'source_update_failed' = 'request_invalid';
  try {
    // Never use actor IDs, account IDs or secrets supplied in an agent reply.
    const saved = await readRequestRecord({ ...options, reference: reference('request', options), recordId: options.recordId });
    const request = JSON.parse(saved.body);
    const source = parseIssueReference(options.sourceUrl);
    if (request.version !== 1 || request.snap_in_id !== options.snapInId || request.source_url !== options.sourceUrl ||
      typeof request.actor_id !== 'string' || !request.actor_id.trim() || request.actor_id.length > 512 ||
      !Number.isSafeInteger(request.created_at) || request.created_at < 0 || request.created_at > Date.now() ||
      request.external_record_id !== `${source.accountId}:${source.issueId}`) throw new Error('Invalid reservation.');
    stage = 'connection_unavailable';
    const resources = client.setupBeta({ endpoint: options.endpoint, token: options.token });
    const keyring = (await resources.snapInsResources({ id: options.snapInId, user: request.actor_id }, { timeout: 10000 })).data.keyrings?.newrelic_context;
    if (keyring?.is_expired) { stage = 'connection_expired'; throw new Error('Expired connection.'); }
    if (typeof keyring?.secret !== 'string' || !keyring.secret.trim()) throw new Error('Missing connection.');
    stage = 'source_update_failed';
    const newrelic = new HttpClient({ org_id: source.region, key: keyring.secret }, 10000);
    const outcome = await newrelic.markIssueInvestigating(source.accountId, source.issueId, request.created_at);
    console.info(`[newrelic-context] investigation:${outcome}`);
    return prefix + statuses[outcome];
  } catch (error) {
    const code = error instanceof NewRelicInvestigationError ? error.code : stage;
    console.info(`[newrelic-context] investigation:unconfirmed code=${code}`);
    return prefix + 'The GitHub issue result is available, but the New Relic investigation update could not be confirmed. ' +
      'Check the source issue and the initiating user’s New Relic connection before retrying; the update may have taken effect. Diagnostic: ' + code + '.';
  }
}

/** Called after the durable winning GitHub result is published. Reporting retries
 * reuse the private outcome; concurrent first deliveries can still race at New Relic.
 */
export async function completeInvestigation(options: RequestContext & { endpoint: string; token: string; recordId?: string }) {
  const outcomeOptions = { bot: options.bot, botId: options.botId, issueId: options.issueId,
    commentId: options.commentId, reference: reference('outcome', options) };
  let body: string;
  try {
    body = (await readRequestRecord(outcomeOptions)).body;
  } catch (error) {
    if (!(error instanceof RequestRecordError) || error.code !== 'request_record_missing') throw new InvestigationCompletionError('investigation_result_failed');
    const result = await perform(options);
    try { body = (await persistRequestRecord({ ...outcomeOptions, body: result })).body; }
    catch { throw new InvestigationCompletionError('investigation_result_failed'); }
  }
  if (!body.startsWith(prefix)) throw new InvestigationCompletionError('investigation_result_failed');
  const fullBody = body + '\n\n[Open source alert](<' + options.sourceUrl + '>)';
  const externalRef = reference('report', options);
  try {
    await options.bot.timelineEntriesCreate({ object: options.issueId, type: publicSDK.TimelineEntriesCreateRequestType.TimelineComment,
      visibility: publicSDK.TimelineEntryVisibility.Internal, external_ref: externalRef, body: fullBody,
    }, { timeout: 10000 });
  } catch {
    // Reconcile duplicate creates and lost responses without repeating the NR write.
    const entries = await options.bot.timelineEntriesList({ object: options.issueId, mode: publicSDK.ListMode.Before, limit: 100 }, { timeout: 10000 })
      .then((result) => result.data.timeline_entries).catch(() => []);
    if (!entries.some((entry) => entry.type === 'timeline_comment' && entry.object === options.issueId &&
      entry.visibility === 'internal' && entry.created_by?.id === options.botId && entry.external_ref === externalRef &&
      'body' in entry && entry.body === fullBody)) throw new InvestigationCompletionError('investigation_report_failed');
  }
}
