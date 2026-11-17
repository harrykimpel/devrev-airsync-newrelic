import extraction from './functions/extraction';
import loading from './functions/loading';
import fetch_newrelic_context from './functions/fetch-newrelic-context';

export const functionFactory = {
  extraction,
  loading,
  fetch_newrelic_context,
} as const;

export type FunctionFactoryType = keyof typeof functionFactory;
