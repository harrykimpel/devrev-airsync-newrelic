import { processLoadingTask } from '@devrev/airsync-sdk';

processLoadingTask({
  task: async () => ({ status: 'error', error: { message: 'New Relic supports import only. Write-back is not supported.' } }),
});
