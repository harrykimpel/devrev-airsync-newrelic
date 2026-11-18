import { AnalysisError, finishAnalysis } from '../fetch_newrelic_context/analysis';

export default async function run(events: unknown[]) {
  try {
    if (!Array.isArray(events)) throw new AnalysisError('invalid_analysis_batch', 'Expected analysis response events.');
    for (const event of events) await finishAnalysis(event);
  } catch (error) {
    console.error(`[newrelic-context] analysis:failed code=${error instanceof AnalysisError ? error.code : 'request_failed'}`);
    // Preserve delivery retries without leaking raw SDK errors or agent content.
    throw new Error('New Relic analysis completion failed. Check the fixed failure code in the function logs.');
  }
}
