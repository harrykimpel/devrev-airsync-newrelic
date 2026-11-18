import { readFileSync } from 'fs';
import { join } from 'path';
import axios from 'axios';
import { client } from '@devrev/typescript-sdk';

import initialize from '../src/functions/initialize_newrelic_context';
import { functionFactory } from '../src/function-factory';

jest.mock('axios');
jest.mock('@devrev/typescript-sdk', () => ({
  ...jest.requireActual('@devrev/typescript-sdk'),
  client: { setup: jest.fn() },
}));

const manifest = require('js-yaml').load(readFileSync(join(__dirname, '../../manifest.yaml'), 'utf8'));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const snapInId = 'don:integration:example:devo/test:snap_in/current-installation';
const initializationEvent = () => ({
  context: { snap_in_id: snapInId },
  payload: { context: { object_id: 'ISS-1' } },
});

test('the issue component names a declared, registered initializer distinct from its action handler', () => {
  const component = manifest.snap_components.find((entry: { name: string }) => entry.name === 'newrelic_context');
  expect(component.initializer).toBe('initialize_newrelic_context');
  expect(manifest.functions).toContainEqual(expect.objectContaining({ name: component.initializer }));
  expect(functionFactory.initialize_newrelic_context).toBe(initialize);
  const action = manifest.snap_kit_actions.find((entry: { name: string }) => entry.name === component.snap_kit_action_name);
  expect(action.function).toBe('fetch_newrelic_context');
  expect(component.initializer).not.toBe(action.function);
});

test('renders both actions using the snap-kit response envelope without a button payload or keyring', async () => {
  const result = await initialize([initializationEvent()]);
  expect(result.snap_kit_body.snap_in_id).toBe(snapInId);
  expect(result.snap_kit_body.snap_in_action_name).toBe(manifest.snap_components[0].snap_kit_action_name);
  expect(manifest.snap_kit_actions).toContainEqual(expect.objectContaining({ name: result.snap_kit_body.snap_in_action_name }));
  const body = result.snap_kit_body.body;
  expect(body).toEqual(manifest.snap_components[0].snap_kit_body);
  const buttons = body.snaps[0].elements[1].elements;
  expect(buttons.map((button) => 'value' in button ? button.value : undefined)).toEqual(['alert', 'recent']);
  expect(buttons).toEqual([
    expect.objectContaining({ action_id: 'fetch_newrelic_context', action_type: 'remote', value: 'alert' }),
    expect.objectContaining({ action_id: 'fetch_newrelic_context', action_type: 'remote', value: 'recent' }),
  ]);
  expect(axios.create).not.toHaveBeenCalled();
  expect(client.setup).not.toHaveBeenCalled();
  expect(console.info).toHaveBeenNthCalledWith(1, '[newrelic-context] initializer:start');
  expect(console.info).toHaveBeenNthCalledWith(2, '[newrelic-context] initializer:ready');
});

test('initialization does not echo credentials, fetch telemetry, or post comments even if passed an action-shaped payload', async () => {
  const result = await initialize([{
    payload: { action: { id: 'fetch_newrelic_context', value: 'recent' }, context: { object_id: 'ISS-1' } },
    context: { snap_in_id: snapInId, secrets: { actor_session_token: 'private-actor-token', service_account_token: 'private-bot-token' } },
    input_data: { keyrings: { newrelic_context: 'private-newrelic-key' } },
  }]);
  expect(JSON.stringify(result)).not.toMatch(/private-actor-token|private-bot-token|private-newrelic-key/);
  expect(JSON.stringify((console.info as jest.Mock).mock.calls)).not.toMatch(/private-actor-token|private-bot-token|private-newrelic-key/);
  expect(axios.create).not.toHaveBeenCalled();
  expect(client.setup).not.toHaveBeenCalled();
});

test('each initializer response has independent UI state', async () => {
  const first = await initialize([initializationEvent()]);
  first.snap_kit_body.body.snaps.length = 0;
  const second = await initialize([initializationEvent()]);
  expect(second.snap_kit_body.body).toEqual(manifest.snap_components[0].snap_kit_body);
});

test('uses the active installation identity rather than a package/version or stale payload identity', async () => {
  const nextSnapInId = 'don:integration:example:devo/test:snap_in/replacement-installation';
  const result = await initialize([{
    context: {
      snap_in_id: nextSnapInId,
      snap_in_version_id: 'don:integration:example:devo/test:snap_in_package/pkg:snap_in_version/version',
      source_id: 'initializer-source-id',
    },
    payload: { parent_id: snapInId, snap_in_action_name: 'stale-action' },
  }]);
  expect(result.snap_kit_body).toMatchObject({ snap_in_id: nextSnapInId, snap_in_action_name: 'fetch_newrelic_context' });
  expect(JSON.stringify(result)).not.toContain('initializer-source-id');
  expect(axios.create).not.toHaveBeenCalled();
  expect(client.setup).not.toHaveBeenCalled();
});

test.each([{}, { context: {} }, { context: { snap_in_id: '' } }, { context: { snap_in_id: 123 } }])('rejects an unbound component response for %j', async (event) => {
  await expect(initialize([event])).rejects.toThrow('missing its snap-in installation ID');
  expect(console.info).toHaveBeenCalledWith('[newrelic-context] initializer:start');
  expect(console.info).not.toHaveBeenCalledWith('[newrelic-context] initializer:ready');
  expect(axios.create).not.toHaveBeenCalled();
  expect(client.setup).not.toHaveBeenCalled();
});
