import { processExtractionTask } from '@devrev/airsync-sdk';

import { normalizeIssue } from '../../external-system/data-normalization';
import { HttpClient, NewRelicApiError } from '../../external-system/http-client';
import { NewRelicIssue } from '../../external-system/types';
import { ExtractorState } from '../index';

processExtractionTask<ExtractorState>({
  task: async ({ adapter }) => {
    const client = new HttpClient(adapter.event);
    const accountId = adapter.event.payload.event_context.external_sync_unit_id;
    adapter.initializeRepos([{ itemType: 'issues', normalize: (item: object) => normalizeIssue(item as NewRelicIssue, accountId, client.region) }]);
    const runId = adapter.event.payload.event_context.run_id;
    // AirSync retains connector state between runs as well as continuations.
    // Only reuse a completion flag, cursor and query window within the same run.
    if (adapter.state.runId !== runId) {
      adapter.state.runId = runId;
      adapter.state.issues = { completed: false };
    }
    const state = adapter.state.issues;
    if (state.completed || !adapter.shouldExtract('issues')) return { status: 'success' };
    if (adapter.isTimeout) return { status: 'progress' };
    // Freeze the query window across continuations. Initial imports cover 30 days;
    // subsequent runs use AirSync's extract_from (with a small overlap).
    state.end ??= Date.now();
    const extractFrom = adapter.event.payload.event_context.extract_from;
    state.start ??= extractFrom ? Date.parse(extractFrom) - 60000 : state.end - 30 * 86400000;
    if (!Number.isFinite(state.start) || state.start < 0 || state.start >= state.end) {
      return { status: 'error', error: { message: 'Invalid extraction time window.' } };
    }
    try {
      const page = await client.getIssues(accountId, state.start, state.end, state.cursor);
      await adapter.getRepo('issues')!.push(page.issues);
      state.cursor = page.nextCursor || undefined;
      state.completed = !state.cursor;
      return { status: state.completed ? 'success' : 'progress' };
    } catch (error) {
      if (error instanceof NewRelicApiError && error.delaySeconds !== undefined) {
        return { status: 'delay', delaySeconds: error.delaySeconds };
      }
      throw error;
    }
  },
});
