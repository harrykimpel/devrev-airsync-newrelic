import { readFileSync, statSync } from 'fs';
import { join } from 'path';

import { functionFactory } from '../src/function-factory';

// DevRev discovers source functions by directory name as well as factory registration.
// A valid factory alone cannot prevent "missing function definitions in source".
const manifest = require('js-yaml').load(readFileSync(join(__dirname, '../../manifest.yaml'), 'utf8')) as {
  functions: { name: string }[];
};

test.each(manifest.functions)('$name has a matching source directory and registered handler', ({ name }) => {
  expect(statSync(join(__dirname, '../src/functions', name, 'index.ts')).isFile()).toBe(true);
  expect(typeof functionFactory[name as keyof typeof functionFactory]).toBe('function');
});
