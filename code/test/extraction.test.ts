import { processExtractionTask } from '@devrev/airsync-sdk';
import { HttpClient, NewRelicApiError } from '../src/functions/external-system/http-client';
import { ExtractorState } from '../src/functions/extraction';

jest.mock('@devrev/airsync-sdk', () => ({ processExtractionTask: jest.fn() }));
jest.mock('../src/functions/external-system/http-client', () => {
  const original = jest.requireActual('../src/functions/external-system/http-client');
  return { ...original, HttpClient: jest.fn() };
});

import '../src/functions/extraction/workers/data-extraction';

const task = (processExtractionTask as jest.Mock).mock.calls[0][0].task;
const getIssues = jest.fn();
const push = jest.fn();
const now = Date.parse('2026-11-17T17:00:00Z');
function adapter(state: ExtractorState = { issues: { completed: false } }) {
  return {
    event: { payload: { event_context: { external_sync_unit_id: '123', run_id: 'run-1', extract_from: undefined as string | undefined } } },
    state, initializeRepos: jest.fn(), shouldExtract: jest.fn().mockReturnValue(true),
    getRepo: jest.fn().mockReturnValue({ push }), isTimeout: false,
  };
}
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(now);
  getIssues.mockReset(); push.mockReset();
  (HttpClient as jest.Mock).mockImplementation(() => ({ getIssues, region: 'US' }));
});
afterEach(() => jest.restoreAllMocks());

test('resumes from a cursor and keeps a fixed window until the last page in a run', async () => {
  const state: ExtractorState = { issues: { completed: false } };
  const first = adapter(state);
  getIssues.mockResolvedValueOnce({ issues: [{ issueId: 'first' }], nextCursor: 'next' });
  expect(await task({ adapter: first })).toEqual({ status: 'progress' });
  expect(state.runId).toBe('run-1');
  expect(state.issues.cursor).toBe('next');
  const { start, end } = state.issues;
  const continued = adapter(JSON.parse(JSON.stringify(state)));
  // Continuations must not rebuild the window from a changed time or extract_from.
  jest.spyOn(Date, 'now').mockReturnValue(now + 60000);
  continued.event.payload.event_context.extract_from = '2026-11-17T16:00:00Z';
  getIssues.mockResolvedValueOnce({ issues: [{ issueId: 'last' }], nextCursor: null });
  expect(await task({ adapter: continued })).toEqual({ status: 'success' });
  expect(getIssues).toHaveBeenLastCalledWith('123', start, end, 'next');
  expect(continued.state).toMatchObject({ runId: 'run-1', issues: { completed: true } });
  expect(push).toHaveBeenCalledTimes(2);
});

test.each([true, false])('starts a new run after a previous run with completed=%s', async (completed) => {
  const persisted = { runId: 'run-1', issues: { completed, cursor: 'stale-cursor', start: 1000, end: 2000 } };
  const next = adapter(JSON.parse(JSON.stringify(persisted)));
  next.event.payload.event_context.run_id = 'run-2';
  next.event.payload.event_context.extract_from = '2026-11-17T16:00:00Z';
  getIssues.mockResolvedValueOnce({ issues: [{ issueId: 'changed' }], nextCursor: 'page-two' });

  expect(await task({ adapter: next })).toEqual({ status: 'progress' });
  const start = Date.parse('2026-11-17T16:00:00Z') - 60000;
  expect(getIssues).toHaveBeenCalledWith('123', start, now, undefined);
  expect(next.state).toEqual({ runId: 'run-2', issues: { completed: false, cursor: 'page-two', start, end: now } });
});

test('migrates legacy completed state without a run ID and applies the initial-import window', async () => {
  const next = adapter({ issues: { completed: true, cursor: 'legacy-cursor', start: 1000, end: 2000 } });
  getIssues.mockResolvedValueOnce({ issues: [], nextCursor: null });
  expect(await task({ adapter: next })).toEqual({ status: 'success' });
  expect(getIssues).toHaveBeenCalledWith('123', now - 30 * 86400000, now, undefined);
  expect(next.state).toEqual({ runId: 'run-1', issues: { completed: true, cursor: undefined, start: now - 30 * 86400000, end: now } });
});

test('delays throttled requests without advancing the cursor', async () => {
  const state = { runId: 'run-1', issues: { completed: false, cursor: 'resume', start: 1000, end: 2000 } };
  getIssues.mockRejectedValueOnce(new NewRelicApiError('throttled', 30));
  expect(await task({ adapter: adapter(state) })).toEqual({ status: 'delay', delaySeconds: 30 });
  expect(state.issues.cursor).toBe('resume');
  expect(push).not.toHaveBeenCalled();
});

test('does not advance pagination when repo push fails', async () => {
  const state = { runId: 'run-1', issues: { completed: false, cursor: 'resume', start: 1000, end: 2000 } };
  getIssues.mockResolvedValueOnce({ issues: [{}], nextCursor: 'next' });
  push.mockRejectedValueOnce(new Error('artifact failure'));
  await expect(task({ adapter: adapter(state) })).rejects.toThrow('artifact failure');
  expect(state.issues.cursor).toBe('resume');
});

test('skips completed extractions only within the same run, excluded types and timed-out work', async () => {
  expect(await task({ adapter: adapter({ runId: 'run-1', issues: { completed: true } }) })).toEqual({ status: 'success' });
  const excluded = adapter(); excluded.shouldExtract.mockReturnValue(false);
  expect(await task({ adapter: excluded })).toEqual({ status: 'success' });
  const timeout = adapter(); timeout.isTimeout = true;
  expect(await task({ adapter: timeout })).toEqual({ status: 'progress' });
  expect(getIssues).not.toHaveBeenCalled();
});
