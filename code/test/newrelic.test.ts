import axios from 'axios';
import { AirSyncEvent } from '@devrev/airsync-sdk';

import { HttpClient, NewRelicApiError } from '../src/functions/external-system/http-client';
import { normalizeIssue } from '../src/functions/external-system/data-normalization';
import metadata from '../src/functions/external-system/external_domain_metadata.json';
import mapping from '../src/functions/external-system/initial_domain_mapping.json';

jest.mock('axios');
const post = jest.fn();
const event = (region = 'US') => ({ payload: { connection_data: { org_id: region, key: 'secret-user-key' } } } as AirSyncEvent);

beforeEach(() => {
  jest.clearAllMocks();
  (axios.create as jest.Mock).mockReturnValue({ post });
  (axios.isAxiosError as unknown as jest.Mock).mockImplementation((e) => e?.isAxiosError === true);
});

test.each([['US', 'https://api.newrelic.com/graphql'], ['eu', 'https://api.eu.newrelic.com/graphql']])('uses the %s endpoint and user-key authentication', (region, baseURL) => {
  new HttpClient(event(region));
  expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
    baseURL, maxRedirects: 0, headers: expect.objectContaining({ 'API-Key': 'secret-user-key', 'nerd-graph-unsafe-experimental-opt-in': 'AiIssues' }),
  }));
});

test('rejects unknown regions and missing keys before making requests', () => {
  expect(() => new HttpClient(event('attacker.example'))).toThrow('api (US) or api.eu (EU)');
  const missing = event(); missing.payload.connection_data.key = '';
  expect(() => new HttpClient(missing)).toThrow('user API key');
  expect(axios.create).not.toHaveBeenCalled();
});

test('discovers accounts and queries the selected account with cursor variables', async () => {
  const client = new HttpClient(event());
  post.mockResolvedValueOnce({ data: { data: { actor: { accounts: [{ id: 123, name: 'Production' }] } } } });
  expect(await client.getAccounts()).toEqual([{ id: 123, name: 'Production' }]);
  const page = { issues: [], nextCursor: 'page-two' };
  post.mockResolvedValueOnce({ data: { data: { actor: { account: { aiIssues: { issues: page } } } } } });
  expect(await client.getIssues('123', 1000, 2000, 'page-one')).toEqual(page);
  expect(post).toHaveBeenLastCalledWith('', { query: expect.stringContaining('startTime: 1000, endTime: 2000'), variables: { accountId: 123, cursor: 'page-one' } });
  await expect(client.getIssues('123) { other }', 1000, 2000)).rejects.toThrow('account ID');
});

test('rejects partial GraphQL errors and inaccessible accounts', async () => {
  const client = new HttpClient(event());
  post.mockResolvedValueOnce({ data: { data: { actor: { accounts: [] } }, errors: [{ message: 'denied' }] } });
  await expect(client.getAccounts()).rejects.toThrow('rejected');
  post.mockResolvedValueOnce({ data: { data: { actor: { account: null } } } });
  await expect(client.getIssues('123', 1000, 2000)).rejects.toThrow('account access');
});

test.each([429, 503, undefined])('returns a retry delay for %s without exposing credentials', async (status) => {
  const client = new HttpClient(event());
  post.mockRejectedValueOnce({ isAxiosError: true, response: status ? { status, headers: { 'retry-after': '120' } } : undefined, config: { headers: { 'API-Key': 'secret-user-key' } } });
  try {
    await client.getAccounts();
    throw new Error('Expected request to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(NewRelicApiError);
    expect((error as NewRelicApiError).delaySeconds).toBe(status ? 120 : 60);
    expect(String(error)).not.toContain('secret-user-key');
  }
});

test('does not retry unauthorized requests or accept a repeated pagination cursor', async () => {
  const client = new HttpClient(event());
  post.mockRejectedValueOnce({ isAxiosError: true, response: { status: 401, headers: {} } });
  await expect(client.getAccounts()).rejects.toMatchObject({ delaySeconds: undefined });
  post.mockResolvedValueOnce({ data: { data: { actor: { account: { aiIssues: { issues: { issues: [], nextCursor: 'same' } } } } } } });
  await expect(client.getIssues('123', 1000, 2000, 'same')).rejects.toThrow('repeated cursor');
});

test('normalizes stable account-qualified IDs, dates, source context and regional URLs', () => {
  const issue = { issueId: 'abc', title: ['Latency', 'Errors'], description: ['Details'], state: 'CLOSED', priority: 'CRITICAL', createdAt: 1000, updatedAt: 2000, entityNames: ['checkout'] };
  const item = normalizeIssue(issue, '123', 'EU');
  expect(item).toMatchObject({ id: '123:abc', created_date: '1970-01-01T00:00:01.000Z', modified_date: '1970-01-01T00:00:02.000Z', data: { title: 'Latency; Errors', state: 'CLOSED', priority: 'CRITICAL', item_url_field: 'https://one.eu.newrelic.com/redirect/issue/abc?accountId=123' } });
  expect((item.data as Record<string, unknown>).body).toContain('Entities: checkout');
  expect((normalizeIssue({ ...issue, title: [] }, '123', 'US').data as Record<string, unknown>).title).toBe('New Relic issue abc');
});

test('metadata and mappings expose import-only issues with no dangling template references', () => {
  expect(Object.keys(metadata.record_types)).toEqual(['issues']);
  expect(metadata.record_types.issues.is_loadable).toBe(false);
  const record = mapping.additional_mappings.record_type_mappings.issues;
  for (const candidate of record.possible_record_type_mappings) {
    expect(candidate.reverse).toBe(false);
    for (const field of Object.values(candidate.shard.stock_field_mappings)) {
      expect(field.reverse).toBe(false);
      if ('primary_external_field' in field) expect(metadata.record_types.issues.fields).toHaveProperty(field.primary_external_field);
    }
  }
  expect(JSON.stringify(mapping)).not.toMatch(/todos|users|creator|owner/i);
});
