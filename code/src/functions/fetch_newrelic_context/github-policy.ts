export const GITHUB_PENDING_PREFIX = '## GitHub issue requested\n\n';
export const GITHUB_RESULT_PREFIX = '## GitHub issue from New Relic analysis\n\n';

export function githubRepository(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const repository = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || ['.', '..'].includes(repository.split('/')[1])) return undefined;
  return repository;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Accept prose/fences around one JSON object, without guessing between reports. */
function resultObject(message: string): Record<string, unknown> | undefined {
  if (message.length > 32768) return undefined;
  try {
    const parsed: unknown = JSON.parse(message);
    return isObject(parsed) ? parsed : undefined;
  } catch { /* Scan for a single balanced object in a formatted agent reply. */ }
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let result: Record<string, unknown> | undefined;
  for (let index = 0; index < message.length; index++) {
    const character = message[index];
    if (start < 0) {
      if (character === '{') { start = index; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{') depth++;
    else if (character === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(message.slice(start, index + 1));
          if (isObject(parsed)) {
            if (result) return undefined;
            result = parsed;
          }
        } catch { /* Braces in ordinary prose are not a result object. */ }
        start = -1;
      }
    }
  }
  return depth === 0 ? result : undefined;
}

function resultUrl(value: string): string {
  const text = value.trim();
  // Use a link's destination, never its display label. Match the entire field
  // so a stray link in a failure message cannot be mistaken for success.
  const markdown = /^\[[^\]\r\n]*\]\((?:<([^<>\s]+)>|([^\s()<>]+))\)$/.exec(text);
  if (markdown) return markdown[1] ?? markdown[2];
  return /^<([^<>\s]+)>$/.exec(text)?.[1] ?? text;
}

/** Validate the agent's report; this does not independently verify its MCP calls. */
export function githubResult(message: string, repository: string): string | undefined {
  try {
    const result = resultObject(message.trim());
    if (!result || (result.status !== 'created' && result.status !== 'existing') || typeof result.url !== 'string') return undefined;
    const url = new URL(resultUrl(result.url));
    const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash ||
      !match || `${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase() ||
      !Number.isSafeInteger(result.issue_number) || result.issue_number !== Number(match[3])) return undefined;
    return GITHUB_RESULT_PREFIX + `Agent reported: ${result.status === 'created' ? 'created' : 'found existing'} [GitHub issue #${result.issue_number}](<${url.href}>).`;
  } catch { return undefined; }
}
