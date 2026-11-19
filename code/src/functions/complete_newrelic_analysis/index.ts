import { AnalysisError, finishAnalysis } from '../fetch_newrelic_context/analysis';
import { RequestRecordError, requestStatus } from '../fetch_newrelic_context/request-record';
import { InvestigationCompletionError } from '../fetch_newrelic_context/investigation';

export default async function run(events: unknown[]) {
  try {
    if (!Array.isArray(events)) throw new AnalysisError('invalid_analysis_batch', 'Expected analysis response events.');
    for (const event of events) await finishAnalysis(event);
  } catch (error) {
    const code = error instanceof AnalysisError || error instanceof RequestRecordError || error instanceof InvestigationCompletionError ? error.code : 'request_failed';
    const status = error instanceof RequestRecordError ? error.status : requestStatus(error);
    console.error(`[newrelic-context] analysis:failed code=${code}${status ? ` status=${status}` : ''}`);
    // Preserve delivery retries without leaking raw SDK errors or agent content.
    throw new Error('New Relic analysis completion failed. Check the fixed failure code in the function logs.');
  }
}
