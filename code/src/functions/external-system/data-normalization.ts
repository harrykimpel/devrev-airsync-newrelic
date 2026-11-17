import { ExternalSyncUnit, NormalizedItem } from '@devrev/airsync-sdk';

import { NewRelicAccount, NewRelicIssue } from './types';

export function normalizeAccount(account: NewRelicAccount): ExternalSyncUnit {
  return {
    id: String(account.id),
    name: account.name,
    description: `New Relic account ${account.id}: alert issues`,
    item_type: 'issues',
  };
}

export function normalizeIssue(issue: NewRelicIssue, accountId: string, region: 'US' | 'EU'): NormalizedItem {
  const host = region === 'EU' ? 'one.eu.newrelic.com' : 'one.newrelic.com';
  return {
    id: `${accountId}:${issue.issueId}`,
    created_date: new Date(issue.createdAt).toISOString(),
    modified_date: new Date(issue.updatedAt).toISOString(),
    data: {
      title: issue.title?.join('; ') || `New Relic issue ${issue.issueId}`,
      body: [issue.description?.join('\n'), `State: ${issue.state}`, `Priority: ${issue.priority}`,
        issue.entityNames?.length ? `Entities: ${issue.entityNames.join(', ')}` : undefined].filter(Boolean).join('\n\n'),
      priority: issue.priority,
      state: issue.state,
      item_url_field: issue.deepLinkUrl || `https://${host}/redirect/issue/${encodeURIComponent(issue.issueId)}?accountId=${accountId}`,
    },
  };
}
