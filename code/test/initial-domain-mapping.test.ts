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

// Required stock issue fields in DevRev's published target-field contract:
// https://developer.devrev.ai/airsync/object-types/issue
// Keep this broader than the field named in the first server error.
const issueFields = mapping.additional_mappings.record_type_mappings.issues.possible_record_type_mappings[0].shard.stock_field_mappings;

test.each(['applies_to_part_id', 'owned_by_ids', 'priority', 'stage', 'title'] as const)('required issue field %s has an enabled creation mapping', (field) => {
  expect(issueFields[field]).toMatchObject({ forward: true, reverse: false });
  expect(issueFields[field].transformation_method_for_set.transformation_method).toEqual(expect.any(String));
});

test.each([
  ['priority', 'P2'],
  ['stage', 'in_development'],
] as const)('required enum %s has a typed fallback when the source value is absent', (field, value) => {
  expect(issueFields[field]).toMatchObject({
    fallback: { type: 'enum', value },
    transformation_method_for_set: { can_apply_to_null: false, use_primary_input: true },
  });
});

test('required title keeps a nonempty text fallback', () => {
  expect(issueFields.title.fallback).toMatchObject({ type: 'text', value: expect.stringMatching(/\S/) });
});

test.each([
  ['applies_to_part_id', 'product', false],
  ['owned_by_ids', 'devu', true],
  ['created_by_id', 'devu', false],
] as const)('reference %s asks the installer for compatible DevRev records', (field, objectType, isArray) => {
  expect(issueFields[field]).toMatchObject({ forward: true, reverse: false });
  expect(issueFields[field].transformation_method_for_set).toEqual({
    transformation_method: 'use_devrev_record',
    leaf_type: { object_category: 'stock', object_type: objectType },
    is_array: isArray,
  });
  // References come from the import's user selections, never invented DONs.
  expect(issueFields[field]).not.toHaveProperty('primary_external_field');
});
