import extraction from './functions/extraction';
import loading from './functions/loading';
import fetch_newrelic_context from './functions/fetch_newrelic_context';
import initialize_newrelic_context from './functions/initialize_newrelic_context';
import complete_newrelic_analysis from './functions/complete_newrelic_analysis';

export const functionFactory = {
  extraction,
  loading,
  fetch_newrelic_context,
  initialize_newrelic_context,
  complete_newrelic_analysis,
} as const;

export type FunctionFactoryType = keyof typeof functionFactory;
