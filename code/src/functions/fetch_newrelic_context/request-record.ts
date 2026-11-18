import { client, publicSDK } from '@devrev/typescript-sdk';
import axios from 'axios';

type TimelineClient = ReturnType<typeof client.setup>;
interface RecordOptions { bot: TimelineClient; issueId: string; commentId: string; botId: string; reference: string; recordId?: string }
export interface RequestRecord { id: string; body: string }
export class RequestRecordError extends Error {
  constructor(readonly code: 'request_record_invalid' | 'request_record_read_failed' | 'request_record_missing' | 'request_record_lookup_incomplete', readonly status?: number) {
    super('Could not validate the private request record.');
  }
}

export function requestStatus(error: unknown): number | undefined {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  return Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined;
}

function recordValue(entry: publicSDK.TimelineEntry, options: RecordOptions): RequestRecord {
  if (!entry?.id || !entry.id.startsWith(options.issueId + ':comment/') || entry.type !== 'timeline_comment' || entry.object !== options.issueId || entry.created_by?.id !== options.botId ||
    entry.visibility !== 'private' || entry.external_ref !== options.reference || !('body' in entry) || typeof entry.body !== 'string') {
    throw new RequestRecordError('request_record_invalid');
  }
  return { id: entry.id, body: entry.body };
}

export async function readRequestRecord(options: RecordOptions): Promise<RequestRecord> {
  if (options.recordId && !options.recordId.startsWith(options.issueId + ':comment/')) throw new RequestRecordError('request_record_invalid');
  let getStatus: number | undefined;
  try {
    // New requests carry the actual record ID. Older requests require lookup by
    // external_ref, which is not implemented consistently across API versions.
    const entry = (await options.bot.timelineEntriesGet(options.recordId
      ? { id: options.recordId } : { id: options.commentId, external_ref: options.reference }, { timeout: 10000 })).data.timeline_entry;
    const record = recordValue(entry, options);
    if (options.recordId && record.id !== options.recordId) throw new RequestRecordError('request_record_invalid');
    return record;
  } catch (error) { getStatus = requestStatus(error); }
  console.info('[newrelic-context] record:lookup_fallback');
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 5; page++) {
    let result: publicSDK.TimelineEntriesListResponse;
    try {
      result = (await options.bot.timelineEntriesList({ object: options.issueId, mode: publicSDK.ListMode.Before,
        visibility: [publicSDK.TimelineEntryVisibility.Private], limit: 100,
        ...(cursor ? { cursor } : {}),
      }, { timeout: 10000 })).data;
    } catch (error) { throw new RequestRecordError('request_record_read_failed', requestStatus(error) ?? getStatus); }
    const matches = result.timeline_entries.filter((entry) => entry.external_ref === options.reference);
    if (matches.length > 1) throw new RequestRecordError('request_record_invalid');
    if (matches.length === 1) {
      const record = recordValue(matches[0], options);
      if (options.recordId && record.id !== options.recordId) throw new RequestRecordError('request_record_invalid');
      return record;
    }
    // Before-mode iteration moves toward older entries using prev_cursor.
    cursor = result.prev_cursor;
    if (!cursor) throw new RequestRecordError('request_record_missing', getStatus);
    if (seen.has(cursor)) break;
    seen.add(cursor);
  }
  throw new RequestRecordError('request_record_lookup_incomplete', getStatus);
}

/** external_ref is unique within a timeline: the first persisted value wins.
 * Private records are visible only to the bot and are never updated or deleted.
 */
export async function persistRequestRecord(options: RecordOptions & { body: string }): Promise<RequestRecord> {
  try {
    const entry = (await options.bot.timelineEntriesCreate({ object: options.issueId,
      type: publicSDK.TimelineEntriesCreateRequestType.TimelineComment,
      visibility: publicSDK.TimelineEntryVisibility.Private, external_ref: options.reference, body: options.body,
    }, { timeout: 10000 })).data.timeline_entry;
    return recordValue(entry, options);
  } catch {
    // Reconcile conflicts and lost create responses by exact reference. A read
    // failure leaves the request retryable; no unverified result is published.
    return readRequestRecord(options);
  }
}
