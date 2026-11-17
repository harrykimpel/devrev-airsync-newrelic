import { AirSyncEvent, spawn } from '@devrev/airsync-sdk';

// Retained only to explicitly reject unexpected loading events from old installations.
export default async function run(events: AirSyncEvent[]) {
  for (const event of events) {
    await spawn({ event, initialState: {}, baseWorkerPath: __dirname });
  }
}
