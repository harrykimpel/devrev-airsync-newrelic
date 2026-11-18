import { NewRelicIssue } from '../external-system/types';

export interface ContextQuery { name: string; query: string; limit: number }
export interface ContextPlan { start: number; end: number; entities: string[]; omittedEntities: number; queries: ContextQuery[] }

export function planContext(issue: NewRelicIssue, mode: 'alert' | 'recent', now: number): ContextPlan {
  if (!Number.isSafeInteger(issue.createdAt) || issue.createdAt < 0 || issue.createdAt > now) {
    throw new Error('New Relic returned an invalid alert creation time.');
  }
  const allEntities = [...new Set(issue.entityGuids ?? [])];
  // GUIDs are opaque base64 identifiers, never entity names or arbitrary NRQL.
  if (allEntities.some((guid) => typeof guid !== 'string' || !/^[A-Za-z0-9_+=/-]{1,256}$/.test(guid))) {
    throw new Error('New Relic returned an invalid entity GUID; no telemetry was queried.');
  }
  const entities = allEntities.slice(0, 10);
  const start = Math.max(0, mode === 'recent' ? now - 30 * 60000 : issue.createdAt - 15 * 60000);
  const end = mode === 'recent' ? now : Math.min(now, issue.createdAt + 15 * 60000);
  if (start >= end) throw new Error('The selected telemetry window is empty.');
  const scope = `WHERE entity.guid IN (${entities.map((guid) => `'${guid}'`).join(', ')})`;
  const window = `SINCE ${start} UNTIL ${end}`;
  const queries = entities.length ? [
    { name: 'APM metrics', limit: 10, query: `FROM Metric SELECT rate(count(apm.service.transaction.duration), 1 minute) AS requestsPerMinute, average(apm.service.transaction.duration) * 1000 AS averageDurationMs, count(apm.service.error.count) / count(apm.service.transaction.duration) * 100 AS errorPercent ${scope} ${window} FACET entity.guid LIMIT 10` },
    { name: 'Recent error/warning logs', limit: 10, query: `FROM Log SELECT timestamp, level, substring(message, 0, 400) AS message, entity.guid, trace.id ${scope} AND level IN ('ERROR', 'WARN', 'WARNING', 'FATAL', 'error', 'warn', 'warning', 'fatal') ${window} LIMIT 10` },
    { name: 'Trace samples (ranked by slowest span)', limit: 5, query: `FROM Span SELECT max(duration) AS slowestSpanSeconds, count(*) AS observedSpans, filter(count(*), WHERE error IS true) AS errorSpans, latest(name) AS exampleSpan ${scope} AND trace.id IS NOT NULL ${window} FACET trace.id LIMIT 5` },
  ] : [];
  return { start, end, entities, omittedEntities: Math.max(0, allEntities.length - entities.length), queries };
}

export function traceSpansQuery(plan: ContextPlan, rows: Record<string, unknown>[]): ContextQuery | undefined {
  const traceIds = rows.slice(0, 5).map((row) => Array.isArray(row.facet) ? row.facet[0] : row.facet)
    .filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id));
  if (!traceIds.length || !plan.entities.length) return undefined;
  return {
    name: 'Sampled spans from the selected traces (not complete traces)', limit: 10,
    query: `FROM Span SELECT timestamp, id, trace.id, entity.guid, name, duration, error WHERE entity.guid IN (${plan.entities.map((id) => `'${id}'`).join(', ')}) AND trace.id IN (${traceIds.map((id) => `'${id}'`).join(', ')}) SINCE ${plan.start} UNTIL ${plan.end} LIMIT 10`,
  };
}

/** Best-effort scrubbing, in addition to selecting only a small allowlist of attributes. */
export function redact(text: string, secrets: string[] = []): string {
  let result = text;
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
  return result
    .replace(/\b(?:NRAK|NRII|NRAL)-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=_-]+/gi, 'Basic [REDACTED]')
    .replace(/(["']?(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|cookie|set-cookie)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL REDACTED]');
}

export interface QueryResult { name: string; query: string; limit: number; rows?: Record<string, unknown>[]; error?: string }

export function renderContext(sourceUrl: string, accountId: string, plan: ContextPlan, results: QueryResult[], secrets: string[]): string {
  const lines = [
    '## New Relic context',
    `[Open source alert](<${sourceUrl}>)`,
    `Account: ${accountId}. UTC window: ${new Date(plan.start).toISOString()} – ${new Date(plan.end).toISOString()}.`,
    `Affected entity GUIDs (${plan.entities.length}): ${plan.entities.join(', ') || 'none supplied by the alert'}.`,
    ...(plan.omittedEntities ? [`Entity limit reached: ${plan.omittedEntities} additional entities were omitted.`] : []),
    'On-demand snapshot. APM metrics require compatible instrumentation. Logs and spans depend on ingestion, sampling, retention and key permissions. Trace summaries cover observed spans in these entities; slowestSpanSeconds is not full trace duration. Empty results do not prove the absence of a problem.',
    'Log messages are truncated and scrubbed for common secrets and email addresses; scrubbing cannot guarantee removal of all sensitive data. This comment is internal to the DevRev organization.',
  ];
  if (!plan.entities.length) lines.push('No telemetry queried: the alert has no entity GUIDs. Account-wide queries are deliberately disabled.');
  for (const result of results) {
    lines.push(`### ${result.name}`, 'NRQL:', '```sql', result.query, '```');
    if (result.error) lines.push(`Unavailable: ${result.error}`);
    else {
      const rows = result.rows ?? [];
      lines.push(`${Math.min(rows.length, result.limit)} rows shown; query limit ${result.limit}${rows.length >= result.limit ? ' (limit reached; additional results may exist)' : ''}.`);
      if (!rows.length) lines.push('No matching data returned.');
      else {
        // Serialize each row independently so truncation is explicit and cannot create a huge comment.
        for (const row of rows.slice(0, result.limit)) {
          // Scrub original strings before JSON escaping, including JSON embedded in log messages.
          const safe = JSON.stringify(row, (_key, value) => typeof value === 'string' ? redact(value, secrets) : value)
            .replace(/`/g, '\\u0060');
          lines.push('```json', safe.length > 650 ? `${safe.slice(0, 650)} … [row truncated]` : safe, '```');
        }
      }
    }
  }
  return lines.join('\n\n');
}
