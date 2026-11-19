import axios, { AxiosInstance } from 'axios';
import { AirSyncEvent } from '@devrev/airsync-sdk';

import { IssuePage, NewRelicAccount, NewRelicIssue } from './types';

export class NewRelicApiError extends Error {
  constructor(message: string, public readonly delaySeconds?: number) {
    super(message);
  }
}

export type AcknowledgmentDiagnostic = 'unspecified' | 'invalid_source_id' | 'source_read_failed' | 'source_state_unsupported' |
  'mutation_request_failed' | 'mutation_rejected' | 'receipt_missing' | 'receipt_error_missing' |
  'receipt_action_mismatch' | 'receipt_account_mismatch' | 'receipt_issue_mismatch' | 'read_back_failed' | 'read_back_pending' | 'sync_read_only';

export class NewRelicAcknowledgmentError extends Error {
  constructor(readonly code: 'rejected' | 'unconfirmed', readonly diagnostic: AcknowledgmentDiagnostic = 'unspecified') {
    super(code === 'rejected'
      ? 'New Relic rejected the acknowledgment. Check that the connection owner can manage alert issues.'
      : 'The acknowledgment could not be confirmed. Check the source issue before retrying; the request may have taken effect.');
  }
}

export type AcknowledgmentStatus = 'acknowledged' | 'already_acknowledged' | 'closed';

export class NewRelicInvestigationError extends Error {
  constructor(readonly code: 'invalid_source' | 'source_read_failed' | 'unsupported_state' | 'mutation_rejected' | 'mutation_unconfirmed' | 'read_back_pending' | 'sync_read_only') {
    super('The New Relic investigation status could not be confirmed.');
  }
}

function positiveEpoch(value: unknown): boolean {
  const timestamp = typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : value;
  return typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp > 0;
}

export class HttpClient {
  private readonly http: AxiosInstance;
  private readonly syncReadOnly: boolean;
  readonly region: 'US' | 'EU';

  constructor(event: AirSyncEvent | { org_id: string; key: string }, timeoutMs = 30000) {
    // The connection's subdomain is a region, never an arbitrary API hostname.
    this.syncReadOnly = 'payload' in event;
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
    if (this.syncReadOnly && /^\s*mutation\b/.test(query)) throw new NewRelicApiError('AirSync clients cannot mutate New Relic issues.');
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

  async getIssue(accountId: string, issueId: string, createdAt: number, includeInvestigation = false): Promise<NewRelicIssue> {
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
            issues { issueId title priority state createdAt updatedAt entityNames entityGuids acknowledgedAt ${includeInvestigation ? 'investigatedAt' : ''} }
          }
        } } }
      }`, { accountId: Number(accountId) });
    const issue = data.actor?.account?.aiIssues?.issues?.issues?.find((candidate) => candidate.issueId === issueId);
    if (!issue) throw new NewRelicApiError('Source issue is unavailable. Check account access and New Relic issue retention.');
    return issue;
  }

  async acknowledgeIssue(accountId: string, issueId: string, createdAt: number): Promise<AcknowledgmentStatus> {
    if (this.syncReadOnly) throw new NewRelicAcknowledgmentError('rejected', 'sync_read_only');
    // Mutations accept only the UUID used by Alert Intelligence, not an arbitrary
    // external identifier or any ID supplied by an agent response.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issueId)) {
      throw new NewRelicAcknowledgmentError('rejected', 'invalid_source_id');
    }
    const acknowledged = (issue: NewRelicIssue) => {
      // EpochMilliseconds is a custom scalar. Accept numeric JSON values and
      // canonical decimal strings, without coercing booleans, dates or objects.
      const raw = issue.acknowledgedAt;
      const timestamp = typeof raw === 'string' && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : raw;
      return typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp > 0;
    };
    let before: NewRelicIssue;
    try { before = await this.getIssue(accountId, issueId, createdAt); }
    catch { throw new NewRelicAcknowledgmentError('unconfirmed', 'source_read_failed'); }
    if (before.state === 'CLOSED') return 'closed';
    if (acknowledged(before)) return 'already_acknowledged';
    if (!['CREATED', 'ACTIVATED', 'DEACTIVATED'].includes(before.state)) throw new NewRelicAcknowledgmentError('rejected', 'source_state_unsupported');
    let data: { aiIssuesAckIssue?: { error?: unknown; result?: { action?: string; accountId?: number; issueId?: string } } } | undefined;
    let receiptDiagnostic: AcknowledgmentDiagnostic | undefined;
    try {
      data = await this.query(`
        mutation($accountId: Int!) {
          aiIssuesAckIssue(accountId: $accountId, issueId: ${JSON.stringify(issueId)}) {
            error
            result { action accountId issueId }
          }
        }`, { accountId: Number(accountId) });
    } catch {
      // A lost response is ambiguous. Reconcile the exact source with reads,
      // never by repeating the mutation or exposing a raw response.
      receiptDiagnostic = 'mutation_request_failed';
    }
    const mutation = data?.aiIssuesAckIssue;
    if (mutation?.error !== null && mutation?.error !== undefined) throw new NewRelicAcknowledgmentError('rejected', 'mutation_rejected');
    if (!receiptDiagnostic) {
      if (!mutation?.result) receiptDiagnostic = 'receipt_missing';
      else if (mutation.error !== null) receiptDiagnostic = 'receipt_error_missing';
      else if (mutation.result.action !== 'ACK') receiptDiagnostic = 'receipt_action_mismatch';
      else if (mutation.result.accountId !== Number(accountId)) receiptDiagnostic = 'receipt_account_mismatch';
      else if (mutation.result.issueId !== issueId) receiptDiagnostic = 'receipt_issue_mismatch';
    }
    let diagnostic: AcknowledgmentDiagnostic = 'read_back_pending';
    // The mutation and the issue-query index need not become visible together.
    // Retry only these reads, never the mutation, and bound both attempts and delay.
    for (const delay of [0, 500, 1500]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const after = await this.getIssue(accountId, issueId, createdAt);
        if (acknowledged(after)) {
          // Report the verified source state, not success inferred from an
          // uncertain/mismatched receipt. getIssue checks the requested UUID.
          if (receiptDiagnostic) console.info(`[newrelic-context] acknowledgment:reconciled code=${receiptDiagnostic}`);
          return 'acknowledged';
        }
        diagnostic = 'read_back_pending';
      } catch { diagnostic = 'read_back_failed'; }
    }
    throw new NewRelicAcknowledgmentError('unconfirmed', receiptDiagnostic ?? diagnostic);
  }

  async markIssueInvestigating(accountId: string, issueId: string, createdAt: number): Promise<'investigating' | 'already_investigating' | 'closed'> {
    if (this.syncReadOnly) throw new NewRelicInvestigationError('sync_read_only');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issueId)) throw new NewRelicInvestigationError('invalid_source');
    let before: NewRelicIssue;
    try { before = await this.getIssue(accountId, issueId, createdAt, true); }
    catch { throw new NewRelicInvestigationError('source_read_failed'); }
    if (before.state === 'CLOSED') return 'closed';
    if (positiveEpoch(before.investigatedAt)) return 'already_investigating';
    if (!['CREATED', 'ACTIVATED', 'DEACTIVATED'].includes(before.state)) throw new NewRelicInvestigationError('unsupported_state');
    let uncertain = false;
    try {
      // Observed from New Relic's Mark as investigating UI operation. Do not
      // assume a particular action string; verify the exact source afterwards.
      const data = await this.query<{ aiIssuesMarkAsInvestigating?: { error?: unknown } }>(`
        mutation markAsInvestigate($accountId: Int!, $issueId: ID!) {
          aiIssuesMarkAsInvestigating(accountId: $accountId, issueId: $issueId) {
            result { accountId action issueId }
            error
          }
        }`, { accountId: Number(accountId), issueId });
      if (data.aiIssuesMarkAsInvestigating?.error != null) throw new NewRelicInvestigationError('mutation_rejected');
      uncertain = !data.aiIssuesMarkAsInvestigating || data.aiIssuesMarkAsInvestigating.error !== null;
    } catch (error) {
      if (error instanceof NewRelicInvestigationError) throw error;
      uncertain = true; // Lost response: reconcile with reads, never resend.
    }
    for (const delay of [0, 500, 1500]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const after = await this.getIssue(accountId, issueId, createdAt, true);
        if (positiveEpoch(after.investigatedAt)) return 'investigating';
      } catch { /* Keep verification bounded and errors credential-free. */ }
    }
    throw new NewRelicInvestigationError(uncertain ? 'mutation_unconfirmed' : 'read_back_pending');
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
