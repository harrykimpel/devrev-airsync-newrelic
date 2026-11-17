import { AirSyncDefaultItemTypes, processExtractionTask } from '@devrev/airsync-sdk';

import { normalizeAccount } from '../../external-system/data-normalization';
import { HttpClient } from '../../external-system/http-client';

processExtractionTask({
  task: async ({ adapter }) => {
    adapter.initializeRepos([{ itemType: AirSyncDefaultItemTypes.EXTERNAL_SYNC_UNITS }]);
    const accounts = await new HttpClient(adapter.event).getAccounts();
    await adapter.getRepo(AirSyncDefaultItemTypes.EXTERNAL_SYNC_UNITS)!.push(accounts.map(normalizeAccount));
    return { status: 'success' };
  },
});
