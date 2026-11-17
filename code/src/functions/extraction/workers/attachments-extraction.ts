import { processExtractionTask } from '@devrev/airsync-sdk';

// Alert issues do not expose file attachments.
processExtractionTask({ task: async () => ({ status: 'success' }) });
