import componentBody from '../fetch_newrelic_context/component-body.json';

/** Component initialization renders the controls; only the action handler fetches telemetry. */
export default async function run(events: unknown[]) {
  if (!Array.isArray(events) || events.length !== 1) throw new Error('Expected one component initialization event.');
  // Initializer events do not contain the button action payload required by the fetch handler.
  // Return the snap-kit response envelope, with a fresh body for each invocation.
  return { snap_kit_body: { body: JSON.parse(JSON.stringify(componentBody)) as typeof componentBody } };
}
