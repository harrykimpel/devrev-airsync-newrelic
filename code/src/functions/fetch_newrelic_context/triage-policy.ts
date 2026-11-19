import { codingResult, CODING_RESULT_PREFIX } from './coding-policy';
import { redact } from './context';
import { githubResult, resultObject, GITHUB_RESULT_PREFIX } from './github-policy';

export const TRIAGE_PENDING_PREFIX = '## New Relic incident triage requested\n\n';
export const TRIAGE_RESULT_PREFIX = '## New Relic incident triage\n\n';
export const TRIAGE_ANALYSIS_SEPARATOR = '\n\n### Incident analysis\n\n';
export interface TriageBinding { repository: string; provider: string }

/** Use only the connector-generated status section, never headings inside AI prose. */
export function triageGitHubBody(body: string): string | undefined {
  if (!body.startsWith(TRIAGE_RESULT_PREFIX)) return undefined;
  const boundary = body.indexOf(TRIAGE_ANALYSIS_SEPARATOR);
  if (boundary < 0) return undefined;
  const status = body.slice(0, boundary);
  const index = status.indexOf(GITHUB_RESULT_PREFIX);
  return index < 0 ? undefined : status.slice(index);
}

export function triageCodingStarted(body: string): boolean {
  const boundary = body.indexOf(TRIAGE_ANALYSIS_SEPARATOR);
  return body.startsWith(TRIAGE_RESULT_PREFIX) && boundary >= 0 && body.slice(0, boundary).includes(CODING_RESULT_PREFIX);
}

export function triageAnalysis(body: string): string | undefined {
  if (!body.startsWith(TRIAGE_RESULT_PREFIX)) return undefined;
  const boundary = body.indexOf(TRIAGE_ANALYSIS_SEPARATOR);
  return boundary < 0 ? undefined : '## New Relic analysis\n\n' + body.slice(boundary + TRIAGE_ANALYSIS_SEPARATOR.length);
}

/** Validate a combined report; the agent's actual tool sequence needs live verification. */
export function triageResult(message: string, binding: TriageBinding, secrets: string[]): string | undefined {
  const report = resultObject(message.trim());
  if (!report || !['completed', 'partial'].includes(report.status as string) || typeof report.analysis !== 'string' || !report.analysis.trim()) return undefined;
  const analysis = redact(report.analysis, secrets).trim();
  if (!analysis) return undefined;
  let status: string;
  if (report.status === 'partial' && report.stopped_at === 'github') {
    if (report.github !== undefined || report.coding !== undefined) return undefined;
    status = 'Analysis completed. No GitHub issue result was validated. Check GitHub before retrying the issue handoff.';
  } else {
    const github = githubResult(JSON.stringify(report.github) ?? '', binding.repository);
    const issue = report.github as { issue_number?: number } | undefined;
    if (!github || !issue?.issue_number) return undefined;
    if (report.status === 'completed') {
      if (report.stopped_at !== undefined) return undefined;
      const coding = codingResult(JSON.stringify(report.coding) ?? '', { ...binding, issue_number: issue.issue_number, operation: 'start' });
      if (!coding) return undefined;
      status = github + '\n\n' + coding;
    } else {
      if (report.stopped_at !== 'coding' || report.coding !== undefined) return undefined;
      status = github + '\n\nCoding assignment was not validated. Check GitHub before using Start coding agent; an assignment may already exist.';
    }
  }
  return TRIAGE_RESULT_PREFIX + status + TRIAGE_ANALYSIS_SEPARATOR + analysis.slice(0, 8000) +
    (analysis.length > 8000 ? '\n\n[Analysis truncated]' : '') + '\n\nAI-generated analysis of bounded telemetry samples. Verify hypotheses against the source evidence.';
}
