import { processExtractionTask } from '@devrev/airsync-sdk';
import { HttpClient, NewRelicApiError } from '../src/functions/external-system/http-client';

jest.mock('@devrev/airsync-sdk', () => ({ processExtractionTask: jest.fn() }));
jest.mock('../src/functions/external-system/http-client', () => {
  const original = jest.requireActual('../src/functions/external-system/http-client');
  return { ...original, HttpClient: jest.fn() };
});

import '../src/functions/extraction/workers/data-extraction';

const task = (processExtractionTask as jest.Mock).mock.calls[0][0].task;
const getIssues = jest.fn();
const push = jest.fn();
function adapter(state: object = { issues: { completed: false } }) {
  return {
    event: { payload: { event_context: { external_sync_unit_id: '123' } } },
    state, initializeRepos: jest.fn(), shouldExtract: jest.fn().mockReturnValue(true),
    getRepo: jest.fn().mockReturnValue({ push }), isTimeout: false,
  };
}
beforeEach(() => {
  getIssues.mockReset(); push.mockReset();
  (HttpClient as jest.Mock).mockImplementation(() => ({ getIssues, region: 'US' }));
});

test('resumes from a cursor and keeps a fixed window until the last page', async () => {
  const state = { issues: { completed: false, cursor: undefined, start: undefined, end: undefined } };
  const first = adapter(state);
  getIssues.mockResolvedValueOnce({ issues: [{ issueId: 'first' }], nextCursor: 'next' });
  expect(await task({ adapter: first })).toEqual({ status: 'progress' });
  expect(state.issues.cursor).toBe('next');
  const { start, end } = state.issues;
  const continued = adapter(JSON.parse(JSON.stringify(state)));
  getIssues.mockResolvedValueOnce({ issues: [{ issueId: 'last' }], nextCursor: null });
  expect(await task({ adapter: continued })).toEqual({ status: 'success' });
  expect(getIssues).toHaveBeenLastCalledWith('123', start, end, 'next');
  expect(continued.state).toMatchObject({ issues: { completed: true } });
  expect(push).toHaveBeenCalledTimes(2);
});

test('delays throttled requests without advancing the cursor', async () => {
  const state = { issues: { completed: false, cursor: 'resume', start: 1000, end: 2000 } };
  getIssues.mockRejectedValueOnce(new NewRelicApiError('throttled', 30));
  expect(await task({ adapter: adapter(state) })).toEqual({ status: 'delay', delaySeconds: 30 });
  expect(state.issues.cursor).toBe('resume');
  expect(push).not.toHaveBeenCalled();
});

test('does not advance pagination when repo push fails', async () => {
  const state = { issues: { completed: false, cursor: 'resume', start: 1000, end: 2000 } };
  getIssues.mockResolvedValueOnce({ issues: [{}], nextCursor: 'next' });
  push.mockRejectedValueOnce(new Error('artifact failure'));
  await expect(task({ adapter: adapter(state) })).rejects.toThrow('artifact failure');
  expect(state.issues.cursor).toBe('resume');
});

test('skips completed, excluded and timed-out extraction', async () => {
  expect(await task({ adapter: adapter({ issues: { completed: true } }) })).toEqual({ status: 'success' });
  const excluded = adapter(); excluded.shouldExtract.mockReturnValue(false);
  expect(await task({ adapter: excluded })).toEqual({ status: 'success' });
  const timeout = adapter(); timeout.isTimeout = true;
  expect(await task({ adapter: timeout })).toEqual({ status: 'progress' });
  expect(getIssues).not.toHaveBeenCalled();
});
