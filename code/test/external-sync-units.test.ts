import { processExtractionTask } from '@devrev/airsync-sdk';
import { HttpClient, NewRelicApiError } from '../src/functions/external-system/http-client';

jest.mock('@devrev/airsync-sdk', () => ({
  AirSyncDefaultItemTypes: { EXTERNAL_SYNC_UNITS: 'external_sync_units' },
  processExtractionTask: jest.fn(),
}));
jest.mock('../src/functions/external-system/http-client', () => {
  const original = jest.requireActual('../src/functions/external-system/http-client');
  return { ...original, HttpClient: jest.fn() };
});

import '../src/functions/extraction/workers/external-sync-units-extraction';

const task = (processExtractionTask as jest.Mock).mock.calls[0][0].task;
const getAccounts = jest.fn();
const push = jest.fn();
const adapter = () => ({
  event: {}, isTimeout: false, initializeRepos: jest.fn(),
  getRepo: jest.fn().mockReturnValue({ push }),
});

beforeEach(() => {
  jest.useFakeTimers();
  getAccounts.mockReset(); push.mockReset();
  (HttpClient as jest.Mock).mockImplementation(() => ({ getAccounts }));
});
afterEach(() => jest.useRealTimers());

test('discovers accounts and publishes normalized sync units once', async () => {
  getAccounts.mockResolvedValue([{ id: 123, name: 'Production' }]);
  await expect(task({ adapter: adapter() })).resolves.toEqual({ status: 'success' });
  expect(push).toHaveBeenCalledWith([{ id: '123', name: 'Production', description: 'New Relic account 123: alert issues', item_type: 'issues' }]);
  expect(getAccounts).toHaveBeenCalledTimes(1);
});

test('honors Retry-After before retrying a transient discovery failure', async () => {
  getAccounts.mockRejectedValueOnce(new NewRelicApiError('rate limited', 2)).mockResolvedValueOnce([]);
  const result = task({ adapter: adapter() });
  await jest.advanceTimersByTimeAsync(1999);
  expect(getAccounts).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toEqual({ status: 'success' });
  expect(getAccounts).toHaveBeenCalledTimes(2);
  expect(push).toHaveBeenCalledTimes(1);
});

test('bounds repeated failures to three attempts and never publishes partial discovery', async () => {
  getAccounts.mockRejectedValue(new NewRelicApiError('temporarily unavailable', 1));
  const result = expect(task({ adapter: adapter() })).rejects.toThrow('retry budget');
  await jest.runAllTimersAsync();
  await result;
  expect(getAccounts).toHaveBeenCalledTimes(3);
  expect(push).not.toHaveBeenCalled();
});

test('rejects delays that cannot fit in the discovery budget without retrying early', async () => {
  getAccounts.mockRejectedValue(new NewRelicApiError('rate limited', 3600));
  await expect(task({ adapter: adapter() })).rejects.toThrow('retry discovery after 3600 seconds');
  expect(getAccounts).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  expect(push).not.toHaveBeenCalled();
});

test('accounts for request time before accepting another retry', async () => {
  const startedAt = Date.now();
  getAccounts.mockImplementationOnce(async () => {
    jest.setSystemTime(startedAt + 30000);
    throw new NewRelicApiError('rate limited', 60);
  }).mockImplementationOnce(async () => {
    jest.setSystemTime(startedAt + 120000);
    throw new NewRelicApiError('rate limited', 100);
  });
  const result = expect(task({ adapter: adapter() })).rejects.toThrow('retry budget');
  await jest.runAllTimersAsync();
  await result;
  expect(getAccounts).toHaveBeenCalledTimes(2);
  expect(push).not.toHaveBeenCalled();
});

test('stops waiting promptly when the SDK requests a soft timeout', async () => {
  const current = adapter();
  getAccounts.mockRejectedValue(new NewRelicApiError('rate limited', 60));
  const result = expect(task({ adapter: current })).rejects.toThrow('timed out');
  await jest.advanceTimersByTimeAsync(1000);
  current.isTimeout = true;
  await jest.advanceTimersByTimeAsync(1000);
  await result;
  expect(getAccounts).toHaveBeenCalledTimes(1);
  expect(push).not.toHaveBeenCalled();
});

test('does not start discovery after the SDK timeout', async () => {
  await expect(task({ adapter: { ...adapter(), isTimeout: true } })).rejects.toThrow('timed out');
  expect(getAccounts).not.toHaveBeenCalled();
});

test('propagates non-retryable failures immediately', async () => {
  const error = new NewRelicApiError('unauthorized');
  getAccounts.mockRejectedValue(error);
  await expect(task({ adapter: adapter() })).rejects.toBe(error);
  expect(getAccounts).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  expect(push).not.toHaveBeenCalled();
});

test('does not retry artifact failures as New Relic requests', async () => {
  getAccounts.mockResolvedValue([]);
  push.mockRejectedValueOnce(new Error('artifact failure'));
  await expect(task({ adapter: adapter() })).rejects.toThrow('artifact failure');
  expect(getAccounts).toHaveBeenCalledTimes(1);
});

test('SDK discovery rejects delay results instead of scheduling a continuation', () => {
  const { getEventTypeForResult } = jest.requireActual('../node_modules/@devrev/airsync-sdk/dist/multithreading/spawn/spawn.helpers.js');
  expect(getEventTypeForResult('START_EXTRACTING_EXTERNAL_SYNC_UNITS', 'delay')).toEqual({
    eventType: 'EXTERNAL_SYNC_UNIT_EXTRACTION_ERROR', illegal: true,
  });
});
