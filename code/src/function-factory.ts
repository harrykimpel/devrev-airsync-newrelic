import extraction from './functions/extraction';
import loading from './functions/loading';
import fetch_newrelic_context from './functions/fetch_newrelic_context';
import initialize_newrelic_context from './functions/initialize_newrelic_context';

export const functionFactory = {
  extraction,
  loading,
  fetch_newrelic_context,
  initialize_newrelic_context,
} as const;

export type FunctionFactoryType = keyof typeof functionFactory;
