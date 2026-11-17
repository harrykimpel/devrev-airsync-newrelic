import axios, { AxiosInstance } from 'axios';
import { AirSyncEvent } from '@devrev/airsync-sdk';

import { IssuePage, NewRelicAccount } from './types';

export class NewRelicApiError extends Error {
  constructor(message: string, public readonly delaySeconds?: number) {
    super(message);
  }
}

export class HttpClient {
  private readonly http: AxiosInstance;
  readonly region: 'US' | 'EU';

  constructor(event: AirSyncEvent) {
    // The connection's subdomain is a region, never an arbitrary API hostname.
    const subdomain = event.payload.connection_data.org_id?.toLowerCase();
    const region = subdomain === 'api' || subdomain === 'us' ? 'US' : subdomain === 'api.eu' || subdomain === 'eu' ? 'EU' : undefined;
    if (region !== 'US' && region !== 'EU') {
      throw new Error('Set the New Relic connection subdomain to api (US) or api.eu (EU).');
    }
    if (!event.payload.connection_data.key) throw new Error('A New Relic user API key is required.');
    this.region = region;
    this.http = axios.create({
      baseURL: region === 'EU' ? 'https://api.eu.newrelic.com/graphql' : 'https://api.newrelic.com/graphql',
      timeout: 30000,
      maxRedirects: 0,
      headers: {
        'API-Key': event.payload.connection_data.key,
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
