export type Region = 'US' | 'EU';

export function newRelicHost(region: Region): string {
  return region === 'EU' ? 'one.eu.newrelic.com' : 'one.newrelic.com';
}

/** New Relic Issues uses the nrai launcher, not the entity redirect router. */
export function issuePermalink(accountId: string, issueId: string, region: Region): string {
  const pane = Buffer.from(JSON.stringify({ isPhoton: true, id: issueId, nerdletId: 'nrai.issue-redirect' })).toString('base64');
  return `https://${newRelicHost(region)}/launcher/nrai.launcher?pane=${encodeURIComponent(pane)}&platform%5BaccountId%5D=${encodeURIComponent(accountId)}`;
}

export interface SourceIssue {
  accountId: string;
  issueId: string;
  region: Region;
}

/** Accept our current and historical links; never use a supplied URL as an API endpoint. */
export function parseIssueReference(reference: string): SourceIssue {
  try {
    if (reference.length > 4096) throw new Error();
    const url = new URL(reference);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['one.newrelic.com', 'one.eu.newrelic.com'].includes(url.hostname)) throw new Error();
    let issueId: string | undefined;
    if (url.pathname === '/launcher/nrai.launcher') {
      const pane = JSON.parse(Buffer.from(url.searchParams.get('pane') ?? '', 'base64').toString('utf8'));
      if (pane.nerdletId === 'nrai.issue-redirect' && typeof pane.id === 'string') issueId = pane.id;
    } else if (url.pathname.startsWith('/redirect/issue/')) {
      issueId = decodeURIComponent(url.pathname.slice('/redirect/issue/'.length));
    }
    const accountId = url.searchParams.get('platform[accountId]') ?? url.searchParams.get('accountId');
    if (!accountId || !/^[1-9]\d*$/.test(accountId) || !Number.isSafeInteger(Number(accountId)) || Number(accountId) > 2147483647 ||
      !issueId || issueId.length > 256 || [...issueId].some((character) => character.charCodeAt(0) <= 32)) throw new Error();
    return { accountId, issueId, region: url.hostname === 'one.eu.newrelic.com' ? 'EU' : 'US' };
  } catch {
    throw new Error('This issue needs a New Relic source link containing its account and issue IDs. Re-sync it with this connector.');
  }
}
