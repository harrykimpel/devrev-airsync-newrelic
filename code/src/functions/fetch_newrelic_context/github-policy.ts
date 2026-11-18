export const GITHUB_PENDING_PREFIX = '## GitHub issue requested\n\n';
export const GITHUB_RESULT_PREFIX = '## GitHub issue from New Relic analysis\n\n';

export function githubRepository(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const repository = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || ['.', '..'].includes(repository.split('/')[1])) return undefined;
  return repository;
}

/** Validate the agent's report; this does not independently verify its MCP calls. */
export function githubResult(message: string, repository: string): string | undefined {
  try {
    const result = JSON.parse(message.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
    if (!['created', 'existing'].includes(result.status) || typeof result.url !== 'string') return undefined;
    const url = new URL(result.url);
    const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash ||
      !match || `${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase() ||
      !Number.isSafeInteger(result.issue_number) || result.issue_number !== Number(match[3])) return undefined;
    return GITHUB_RESULT_PREFIX + `Agent reported: ${result.status === 'created' ? 'created' : 'found existing'} [GitHub issue #${result.issue_number}](<${url.href}>).`;
  } catch { return undefined; }
}
