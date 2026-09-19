// The source is written the way rollup reads it - `./logging`, `../utils`, and
// in one place `./config.js` - none of which node's ESM resolver will accept
// from a .ts file, since it only ever resolves a specifier literally. This hook
// fills in what rollup would have inferred, and is loaded for test runs only, so
// the build and the shipped bundle are untouched.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// in the order rollup would try them
const candidatesFor = (specifier) => {
  // a .js specifier beside a .ts file is the typescript convention, and the one
  // in modules/logging.ts - the emitted file will be .js, the source is not
  if (specifier.endsWith('.js')) {
    return [specifier.slice(0, -3) + '.ts'];
  }

  return [`${specifier}.ts`, `${specifier}/index.ts`];
};

export const resolve = (specifier, context, next) => {
  // bare specifiers are packages, and anything already pointing at a real file
  // needs no help
  if (specifier.startsWith('.') && context.parentURL) {
    for (const candidate of candidatesFor(specifier)) {
      const url = new URL(candidate, context.parentURL);

      if (existsSync(fileURLToPath(url))) {
        return next(url.href, context);
      }
    }
  }

  return next(specifier, context);
};
