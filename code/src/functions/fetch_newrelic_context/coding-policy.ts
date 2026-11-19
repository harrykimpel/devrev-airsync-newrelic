import { githubUrl, resultObject } from './github-policy';

export const CODING_PENDING_PREFIX = '## Coding agent requested\n\n';
export const CODING_RESULT_PREFIX = '## Coding agent progress\n\n';

// Add a provider here with its own dispatch instructions and tool contract.
// Unrecognized configuration never falls back to a different coding agent.
const providers = {
  copilot: {
    id: 'copilot', label: 'GitHub Copilot',
    instructions: 'Only in the explicitly authorized assignment step, use assign_copilot_to_issue with owner, repo and the verified issue_number; pass base_ref only when supplied. ' +
      'In custom_instructions ask Copilot to investigate the reported symptoms, treat analysis causes as hypotheses, implement a focused fix with meaningful tests, follow repository instructions, and create its fix PR for human review. Include the correlation_marker. ' +
      'Copilot creates its own branch and PR. Do not call create_pr or create_pull_request, create an empty PR, write code yourself, or start another agent. ',
  },
};

export function codingProvider(value: unknown) {
  const id = value === undefined || value === '' ? 'copilot' : typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(providers, id) ? providers[id as keyof typeof providers] : undefined;
}

export interface CodingBinding {
  repository: string; issue_number: number; provider: string; operation: 'start' | 'status';
}

/** A report is not an independent attestation of GitHub MCP execution. */
export function codingResult(message: string, binding: CodingBinding): string | undefined {
  const result = resultObject(message.trim());
  const provider = codingProvider(binding.provider);
  if (!result || !provider || result.provider !== provider.id || result.issue_number !== binding.issue_number) return undefined;
  const issueUrl = githubUrl(result.issue_url, binding.repository, 'issues', binding.issue_number);
  if (!issueUrl) return undefined;
  const issue = `[GitHub issue #${binding.issue_number}](<${issueUrl}>)`;
  if (result.status === 'pull_request') {
    const url = githubUrl(result.pr_url, binding.repository, 'pull', result.pr_number);
    if (!url || typeof result.draft !== 'boolean' || !['open', 'closed', 'merged'].includes(result.pr_state as string)) return undefined;
    return CODING_RESULT_PREFIX + `Agent reported: ${provider.label} has a ${result.draft ? 'draft ' : ''}PR (${result.pr_state}) for ${issue}: ` +
      `[PR #${result.pr_number}](<${url}>).\n\nReview the changes and test results on GitHub before merging.`;
  }
  // Never imply that assignment proves work completed, or accept a stray PR
  // field as a second, conflicting result.
  if (result.pr_url !== undefined || result.pr_number !== undefined || result.pr_state !== undefined || result.draft !== undefined) return undefined;
  if (result.status === 'assigned') return CODING_RESULT_PREFIX + `Agent reported: ${provider.label} is assigned to ${issue}. No linked PR was verified yet. Use **Check coding progress** later.`;
  if (result.status === 'not_started' && binding.operation === 'status') {
    return CODING_RESULT_PREFIX + `Agent reported: no ${provider.label} assignment or linked PR was found for ${issue}. This check did not start a coding run.`;
  }
  return undefined;
}
