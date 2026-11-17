import axios, { AxiosInstance } from 'axios';
import { AirSyncEvent } from '@devrev/airsync-sdk';

import { IssuePage, NewRelicAccount, NewRelicIssue } from './types';

export class NewRelicApiError extends Error {
  constructor(message: string, public readonly delaySeconds?: number) {
    super(message);
  }
}

export class HttpClient {
  private readonly http: AxiosInstance;
  readonly region: 'US' | 'EU';

  constructor(event: AirSyncEvent | { org_id: string; key: string }, timeoutMs = 30000) {
    // The connection's subdomain is a region, never an arbitrary API hostname.
    const connection = 'payload' in event ? event.payload.connection_data : event;
    const subdomain = connection.org_id?.toLowerCase();
    const region = subdomain === 'api' || subdomain === 'us' ? 'US' : subdomain === 'api.eu' || subdomain === 'eu' ? 'EU' : undefined;
    if (region !== 'US' && region !== 'EU') {
      throw new Error('Set the New Relic connection subdomain to api (US) or api.eu (EU).');
    }
    if (!connection.key) throw new Error('A New Relic user API key is required.');
    this.region = region;
    this.http = axios.create({
      baseURL: region === 'EU' ? 'https://api.eu.newrelic.com/graphql' : 'https://api.newrelic.com/graphql',
      timeout: timeoutMs,
      maxRedirects: 0,
      headers: {
        'API-Key': connection.key,
        'Content-Type': 'application/json',
        'nerd-graph-unsafe-experimental-opt-in': 'AiIssues',
      },
    });
  }

  private async query<T>(query: string, variables: object = {}): Promise<T> {
    try {
      const response = await this.http.post<{ data?: T; errors?: { extensions?: { errorClass?: string } }[] }>('', { query, variables });
      if (response.data.errors?.length) {
        const retryable = response.data.errors.some((e) => e.extensions?.errorClass === 'THROTTLED');
        throw new NewRelicApiError('New Relic rejected the NerdGraph query. Check key permissions and API schema.', retryable ? 60 : undefined);
      }
      if (!response.data.data) throw new NewRelicApiError('New Relic returned no query data.');
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const retryable = !status || status === 429 || status >= 500;
        const retryAfter = error.response?.headers['retry-after'];
        const seconds = retryAfter && /^\d+$/.test(String(retryAfter))
          ? Number(retryAfter)
          : Math.ceil((Date.parse(String(retryAfter)) - Date.now()) / 1000);
        // Never propagate Axios errors: they include the API key in config.headers.
        throw new NewRelicApiError(`New Relic request failed (${status ?? 'network error'}).`,
          retryable ? (Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3600) : 60) : undefined);
      }
      throw error;
    }
  }

  async getAccounts(): Promise<NewRelicAccount[]> {
    const data = await this.query<{ actor: { accounts: NewRelicAccount[] } }>(
      'query { actor { accounts { id name } } }',
    );
    if (!Array.isArray(data.actor?.accounts)) throw new NewRelicApiError('New Relic returned no accounts.');
    return data.actor.accounts;
  }

  async getIssue(accountId: string, issueId: string, createdAt: number): Promise<NewRelicIssue> {
    if (!/^[1-9]\d*$/.test(accountId) || Number(accountId) > 2147483647 ||
      !issueId || issueId.length > 256 || !Number.isSafeInteger(createdAt) || createdAt < 0 || createdAt > Date.now()) {
      throw new Error('Invalid New Relic issue reference or creation date.');
    }
    // Some imported DevRev records use their import time as created_date.
    // Cover the connector's initial 30-day lookback as well as older preserved dates.
    const start = Math.max(0, Math.min(createdAt - 60000, Date.now() - 30 * 86400000));
    const data = await this.query<{ actor: { account: { aiIssues: { issues: IssuePage } } } }>(`
      query($accountId: Int!) {
        actor { account(id: $accountId) { aiIssues {
          issues(filter: { ids: [${JSON.stringify(issueId)}] }, timeWindow: { startTime: ${start}, endTime: ${Date.now()} }) {
            issues { issueId title priority state createdAt updatedAt entityNames entityGuids }
          }
        } } }
      }`, { accountId: Number(accountId) });
    const issue = data.actor?.account?.aiIssues?.issues?.issues?.find((candidate) => candidate.issueId === issueId);
    if (!issue) throw new NewRelicApiError('Source issue is unavailable. Check account access and New Relic issue retention.');
    return issue;
  }

  async nrql(accountId: string, query: string): Promise<Record<string, unknown>[]> {
    if (!/^[1-9]\d*$/.test(accountId) || Number(accountId) > 2147483647) throw new Error('Invalid New Relic account ID.');
    const data = await this.query<{ actor: { account: { nrql: { results: Record<string, unknown>[] } } } }>(`
      query($accountId: Int!, $query: Nrql!) {
        actor { account(id: $accountId) { nrql(query: $query, timeout: 5) { results } } }
      }`, { accountId: Number(accountId), query });
    const results = data.actor?.account?.nrql?.results;
    if (!Array.isArray(results)) throw new NewRelicApiError('New Relic returned no NRQL results. Check account query permissions.');
    return results;
  }

  async getIssues(accountId: string, start: number, end: number, cursor?: string): Promise<IssuePage> {
    if (!/^[1-9]\d*$/.test(accountId) || !Number.isSafeInteger(Number(accountId))) {
      throw new Error('The selected sync unit must be a New Relic account ID.');
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end) {
      throw new Error('Invalid extraction time window.');
    }
    const data = await this.query<{ actor: { account: { aiIssues: { issues: IssuePage } } } }>(`
      query($accountId: Int!, $cursor: String) {
        actor { account(id: $accountId) { aiIssues {
          issues(cursor: $cursor, timeWindow: { startTime: ${start}, endTime: ${end} }) {
            issues { issueId title description priority state createdAt updatedAt entityNames }
            nextCursor
          }
        } } }
      }`, { accountId: Number(accountId), cursor: cursor ?? null });
    const page = data.actor?.account?.aiIssues?.issues;
    if (!page || !Array.isArray(page.issues)) throw new NewRelicApiError('New Relic returned no issues page. Check account access.');
    if (page.nextCursor && page.nextCursor === cursor) throw new NewRelicApiError('New Relic returned a repeated cursor.');
    return page;
  }
}
