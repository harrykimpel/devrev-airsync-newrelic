import { processExtractionTask } from '@devrev/airsync-sdk';

import externalDomainMetadata from '../../external-system/external_domain_metadata.json';

processExtractionTask({
  task: async ({ adapter }) => {
    adapter.initializeRepos([{ itemType: 'external_domain_metadata' }]);
    await adapter.getRepo('external_domain_metadata')!.push([externalDomainMetadata]);
    return { status: 'success' };
  },
});
