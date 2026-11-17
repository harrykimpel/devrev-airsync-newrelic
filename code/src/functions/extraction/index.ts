import { AirSyncEvent, spawn } from '@devrev/airsync-sdk';

import initialDomainMapping from '../external-system/initial_domain_mapping.json';

export interface ExtractorState {
  issues: { completed: boolean; cursor?: string; start?: number; end?: number };
}

export const initialExtractorState: ExtractorState = { issues: { completed: false } };

export default async function run(events: AirSyncEvent[]) {
  for (const event of events) {
    await spawn<ExtractorState>({ event, initialState: initialExtractorState, initialDomainMapping, baseWorkerPath: __dirname });
  }
}
