import { client } from '@devrev/typescript-sdk';
import { readRequestRecord, persistRequestRecord } from '../src/functions/fetch_newrelic_context/request-record';

const issueId = 'don:core:dvrv-us-1:devo/test:issue/1';
const botId = 'don:identity:dvrv-us-1:devo/test:svc_acc/bot';
const reference = 'newrelic-binding:abc';
const record = { id: issueId + ':comment/record', type: 'timeline_comment', visibility: 'private',
  object: issueId, created_by: { id: botId }, external_ref: reference, body: 'fingerprint' };
const get = jest.fn(), list = jest.fn(), create = jest.fn();
const bot = { timelineEntriesGet: get, timelineEntriesList: list, timelineEntriesCreate: create } as unknown as ReturnType<typeof client.setup>;
const options = { bot, issueId, commentId: issueId + ':comment/pending', botId, reference };

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  get.mockRejectedValue({ isAxiosError: true, response: { status: 404 } });
  list.mockResolvedValue({ data: { timeline_entries: [] } });
});
afterEach(() => jest.restoreAllMocks());

test('reads a stored record ID directly and validates its exact reference', async () => {
  get.mockResolvedValue({ data: { timeline_entry: record } });
  await expect(readRequestRecord({ ...options, recordId: record.id })).resolves.toEqual({ id: record.id, body: record.body });
  expect(get).toHaveBeenCalledWith({ id: record.id }, { timeout: 10000 });
  expect(list).not.toHaveBeenCalled();
});

test('finds older records using private before-mode pagination, including an empty page', async () => {
  list.mockResolvedValueOnce({ data: { timeline_entries: [], prev_cursor: 'older', next_cursor: 'wrong-direction' } });
  list.mockResolvedValueOnce({ data: { timeline_entries: [record] } });
  await expect(readRequestRecord(options)).resolves.toEqual({ id: record.id, body: record.body });
  expect(list).toHaveBeenNthCalledWith(2, { object: issueId, mode: 'before', visibility: ['private'], limit: 100, cursor: 'older' }, { timeout: 10000 });
});

test.each(['owner', 'object', 'visibility', 'reference', 'id'])('does not accept a fallback record with a mismatched %s', async (field) => {
  const entry = { ...record };
  if (field === 'owner') entry.created_by = { id: 'other-user' };
  if (field === 'object') entry.object = 'other-issue';
  if (field === 'visibility') entry.visibility = 'internal';
  if (field === 'reference') entry.external_ref = 'different-reference';
  if (field === 'id') entry.id = 'other-issue:comment/record';
  list.mockResolvedValue({ data: { timeline_entries: [entry] } });
  await expect(readRequestRecord(options)).rejects.toThrow();
});

test('does not substitute a different ID when a binding explicitly names one record', async () => {
  list.mockResolvedValue({ data: { timeline_entries: [record] } });
  await expect(readRequestRecord({ ...options, recordId: issueId + ':comment/another-record' })).rejects.toMatchObject({ code: 'request_record_invalid' });
});

test.each(['repeated cursor', 'page limit'])('bounds an incomplete private-record search (%s)', async (mode) => {
  let page = 0;
  list.mockImplementation(async () => ({ data: { timeline_entries: [], prev_cursor: mode === 'page limit' ? 'page-' + page++ : 'same-cursor' } }));
  await expect(readRequestRecord(options)).rejects.toMatchObject({ code: 'request_record_lookup_incomplete' });
  expect(list.mock.calls.length).toBe(mode === 'page limit' ? 5 : 2);
});

test('rejects ambiguous duplicate references', async () => {
  list.mockResolvedValue({ data: { timeline_entries: [record, { ...record, id: issueId + ':comment/duplicate' }] } });
  await expect(readRequestRecord(options)).rejects.toMatchObject({ code: 'request_record_invalid' });
});

test('reconciles a lost create response through the same validated fallback', async () => {
  create.mockRejectedValue(new Error('transport response lost'));
  list.mockResolvedValue({ data: { timeline_entries: [record] } });
  await expect(persistRequestRecord({ ...options, body: 'different losing candidate' })).resolves.toEqual({ id: record.id, body: record.body });
});
