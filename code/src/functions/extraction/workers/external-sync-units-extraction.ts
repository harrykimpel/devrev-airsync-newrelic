import { AirSyncDefaultItemTypes, processExtractionTask } from '@devrev/airsync-sdk';

import { normalizeAccount } from '../../external-system/data-normalization';
import { HttpClient, NewRelicApiError } from '../../external-system/http-client';
import { NewRelicAccount } from '../../external-system/types';

const MAX_ATTEMPTS = 3;
const RETRY_BUDGET_MS = 4 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;

async function discoverAccounts(client: HttpClient, isTimeout: () => boolean): Promise<NewRelicAccount[]> {
  const deadline = Date.now() + RETRY_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    if (isTimeout()) throw new NewRelicApiError('New Relic account discovery timed out. Please retry discovery.');
    if (Date.now() + REQUEST_TIMEOUT_MS >= deadline) {
      throw new NewRelicApiError('New Relic account discovery exceeded its retry budget. Please retry discovery.');
    }
    try {
      return await client.getAccounts();
    } catch (error) {
      if (!(error instanceof NewRelicApiError) || error.delaySeconds === undefined) throw error;
      const retryAt = Date.now() + error.delaySeconds * 1000;
      if (attempt >= MAX_ATTEMPTS || retryAt + REQUEST_TIMEOUT_MS >= deadline) {
        throw new NewRelicApiError(`New Relic account discovery could not finish within its retry budget. Please retry discovery after ${error.delaySeconds} seconds.`);
      }
      // SDK 2.0.0 discovery is not resumable: returning 'delay' emits an error.
      // Retry here, honoring Retry-After without sleeping through a soft timeout.
      while (Date.now() < retryAt) {
        if (isTimeout()) throw new NewRelicApiError('New Relic account discovery timed out. Please retry discovery.');
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1000, retryAt - Date.now())));
      }
    }
  }
}

processExtractionTask({
  task: async ({ adapter }) => {
    adapter.initializeRepos([{ itemType: AirSyncDefaultItemTypes.EXTERNAL_SYNC_UNITS }]);
    const accounts = await discoverAccounts(new HttpClient(adapter.event), () => adapter.isTimeout);
    await adapter.getRepo(AirSyncDefaultItemTypes.EXTERNAL_SYNC_UNITS)!.push(accounts.map(normalizeAccount));
    return { status: 'success' };
  },
});
