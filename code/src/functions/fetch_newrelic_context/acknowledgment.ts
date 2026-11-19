import { client, publicSDK } from '@devrev/typescript-sdk';
import axios from 'axios';

import { AcknowledgmentDiagnostic, AcknowledgmentStatus, HttpClient, NewRelicAcknowledgmentError } from '../external-system/http-client';

type Outcome = AcknowledgmentStatus | 'rejected' | 'unconfirmed';
const descriptions: Record<Outcome, string> = {
  acknowledged: 'The source New Relic issue is acknowledged. The acknowledgment was verified by reading it back from New Relic.',
  already_acknowledged: 'The source New Relic issue was already acknowledged. No acknowledgment was sent.',
  closed: 'The source New Relic issue is already closed. No acknowledgment was sent; this does not establish that a fix was deployed or recovery was verified.',
  rejected: 'New Relic did not accept the acknowledgment. Check that the existing connection owner can manage alert issues. Inspect the source issue before retrying.',
  unconfirmed: 'The acknowledgment could not be confirmed. Check the source issue and connection permissions before retrying; the request may have taken effect.',
};

/** Runs only during the user action; neither the user key nor token is saved for callbacks. */
export async function acknowledgeSource(options: {
  newrelic: HttpClient; devrev: ReturnType<typeof client.setup>; issueId: string;
  accountId: string; sourceIssueId: string; createdAt: number; sourceUrl: string; requestHash: string;
}) {
  let outcome: Outcome;
  let diagnostic: AcknowledgmentDiagnostic | undefined;
  try {
    outcome = await options.newrelic.acknowledgeIssue(options.accountId, options.sourceIssueId, options.createdAt);
  } catch (error) {
    // Responses and SDK errors must never become comment text or log messages.
    outcome = error instanceof NewRelicAcknowledgmentError ? error.code : 'unconfirmed';
    diagnostic = error instanceof NewRelicAcknowledgmentError ? error.diagnostic : 'unspecified';
  }
  console.info(`[newrelic-context] acknowledgment:${outcome}`);
  if (diagnostic) console.info(`[newrelic-context] acknowledgment:diagnostic code=${diagnostic}`);
  const explanation = diagnostic === 'source_read_failed'
    ? 'The source issue could not be read. No acknowledgment was sent; check source account access, retention and the imported creation date.'
    : diagnostic === 'read_back_pending'
    ? 'New Relic accepted the acknowledgment, but its issue query has not yet shown the acknowledgment timestamp after three checks. The issue may already appear acknowledged in New Relic.'
    : diagnostic === 'read_back_failed'
    ? 'New Relic accepted the acknowledgment, but the subsequent issue queries failed. Check the source issue before retrying.'
    : descriptions[outcome];
  const detail = explanation + (diagnostic ? ` Diagnostic: ${diagnostic}.` : '');
  const externalRef = `newrelic-acknowledgment:${options.requestHash}`;
  let reported = false;
  try {
    await options.devrev.timelineEntriesCreate({
      object: options.issueId, type: publicSDK.TimelineEntriesCreateRequestType.TimelineComment,
      visibility: publicSDK.TimelineEntryVisibility.Internal, external_ref: externalRef,
      body: '## New Relic acknowledgment\n\n' + detail + '\n\n[Open source alert](<' + options.sourceUrl + '>)',
    }, { timeout: 10000 });
    reported = true;
  } catch (error) {
    if (axios.isAxiosError(error) && [400, 409].includes(error.response?.status ?? 0)) {
      // A repeated delivery can observe an already-acknowledged issue. Preserve
      // the first comment for that click instead of overwriting its outcome.
      try {
        const entries = (await options.devrev.timelineEntriesList({ object: options.issueId,
          mode: publicSDK.ListMode.Before, limit: 100 }, { timeout: 10000 })).data.timeline_entries;
        reported = entries.some((entry) => entry.object === options.issueId && entry.type === 'timeline_comment' &&
          entry.visibility === 'internal' && entry.external_ref === externalRef);
      } catch { /* Reporting failures must not prevent incident triage. */ }
    }
  }
  if (!reported) console.error('[newrelic-context] acknowledgment:report_failed');
  return { outcome, detail: detail + (reported ? '' : ' The result could not be posted to the internal discussion.') };
}
