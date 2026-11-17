import mapping from '../src/functions/external-system/initial_domain_mapping.json';

// The SDK types this document as `object`. These server-required jq options
// therefore need explicit contract checks; TypeScript cannot catch omissions.
function rawJqTransformations(value: unknown, path = '$'): { path: string; value: Record<string, unknown> }[] {
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  const current = object.transformation_method === 'use_raw_jq' ? [{ path, value: object }] : [];
  return current.concat(Object.entries(object).flatMap(([key, child]) => rawJqTransformations(child, `${path}.${key}`)));
}

test('every raw jq mapping declares the required null and input handling options', () => {
  const transformations = rawJqTransformations(mapping);
  expect(transformations.length).toBeGreaterThan(0);
  for (const { path, value } of transformations) {
    expect({ path, can_apply_to_null: value.can_apply_to_null, use_primary_input: value.use_primary_input }).toEqual({
      path, can_apply_to_null: expect.any(Boolean), use_primary_input: expect.any(Boolean),
    });
    expect(value.forward_jq).toEqual(expect.any(String));
  }
});

test.each(['priority', 'stage'] as const)('%s jq consumes the primary external field and skips null input', (field) => {
  const fields = mapping.additional_mappings.record_type_mappings.issues.possible_record_type_mappings[0].shard.stock_field_mappings;
  expect(fields[field].transformation_method_for_set).toMatchObject({
    transformation_method: 'use_raw_jq', can_apply_to_null: false, use_primary_input: true,
  });
  expect(fields[field].primary_external_field).toBe(field === 'priority' ? 'priority' : 'state');
});
