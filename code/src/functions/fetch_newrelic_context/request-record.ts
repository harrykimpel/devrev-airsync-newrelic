import { client, publicSDK } from '@devrev/typescript-sdk';

type TimelineClient = ReturnType<typeof client.setup>;
interface RecordOptions { bot: TimelineClient; issueId: string; commentId: string; botId: string; reference: string }

function recordBody(entry: publicSDK.TimelineEntry, options: RecordOptions): string {
  if (!entry?.id || !entry.id.startsWith(options.issueId + ':comment/') || entry.type !== 'timeline_comment' || entry.object !== options.issueId || entry.created_by?.id !== options.botId ||
    entry.visibility !== 'private' || entry.external_ref !== options.reference || !('body' in entry) || typeof entry.body !== 'string') {
    throw new Error('The request record is not owned by this snap-in.');
  }
  return entry.body;
}

export async function readRequestRecord(options: RecordOptions): Promise<string> {
  const entry = (await options.bot.timelineEntriesGet({ id: options.commentId, external_ref: options.reference }, { timeout: 10000 })).data.timeline_entry;
  return recordBody(entry, options);
}

/** external_ref is unique within a timeline: the first persisted value wins.
 * Private records are visible only to the bot and are never updated or deleted.
 */
export async function persistRequestRecord(options: RecordOptions & { body: string }): Promise<string> {
  try {
    const entry = (await options.bot.timelineEntriesCreate({ object: options.issueId,
      type: publicSDK.TimelineEntriesCreateRequestType.TimelineComment,
      visibility: publicSDK.TimelineEntryVisibility.Private, external_ref: options.reference, body: options.body,
    }, { timeout: 10000 })).data.timeline_entry;
    return recordBody(entry, options);
  } catch {
    // Reconcile conflicts and lost create responses by exact reference. A read
    // failure leaves the request retryable; no unverified result is published.
    return readRequestRecord(options);
  }
}
