import componentBody from '../fetch_newrelic_context/component-body.json';

/** Component initialization renders the controls; only the action handler fetches telemetry. */
export default async function run(events: unknown[]) {
  console.info('[newrelic-context] initializer:start');
  if (!Array.isArray(events) || events.length !== 1) throw new Error('Expected one component initialization event.');
  const event = events[0] as { context?: { snap_in_id?: unknown } } | undefined;
  const snapInId = event?.context?.snap_in_id;
  if (typeof snapInId !== 'string' || !snapInId.trim()) {
    throw new Error('The component initialization event is missing its snap-in installation ID.');
  }
  // Initializer events do not contain the button action payload required by the fetch handler.
  // The installation ID and manifest action name bind remote controls to the live action.
  // Never substitute a package/version ID or retain an ID from an earlier installation.
  const response = {
    snap_kit_body: {
      snap_in_id: snapInId,
      snap_in_action_name: 'fetch_newrelic_context',
      body: JSON.parse(JSON.stringify(componentBody)) as typeof componentBody,
    },
  };
  console.info('[newrelic-context] initializer:ready');
  return response;
}
