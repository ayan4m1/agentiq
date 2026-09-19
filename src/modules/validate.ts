import { getLogger } from './logging';
import { getParameters } from '../utils';
import type { ToolParameter, Validation } from '../types';

const log = getLogger('validate');

type Coercion = {
  ok: boolean;
  value?: unknown;
  problem?: string;
};

const truthy = ['true', 'yes', '1'];
const falsy = ['false', 'no', '0'];

const describeValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return 'an array';
  }

  return `a ${typeof value}`;
};

// what the parameter wanted, phrased for the model rather than as a schema
const describeParam = (param: ToolParameter) =>
  param.items ? `an array of ${param.items}` : `a ${param.type}`;

// a model that answers with JSON inside a string is answering correctly enough
// to be worth unwrapping - the alternative is a round trip to say so
const reparse = (value: unknown) => {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

// small models get the shape right far more often than the types, so fix what
// can only have been meant one way and complain about the rest
const coerce = (value: unknown, type: string, items?: string): Coercion => {
  switch (type) {
    case 'string':
      if (typeof value === 'string') {
        return { ok: true, value };
      }

      // a number or a boolean where a string belongs is unambiguous
      if (typeof value === 'number' || typeof value === 'boolean') {
        return { ok: true, value: String(value) };
      }

      return {
        ok: false,
        problem: `must be a string, got ${describeValue(value)}`
      };
    case 'number':
    case 'integer': {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return { ok: true, value };
      }

      if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);

        if (Number.isFinite(parsed)) {
          return { ok: true, value: parsed };
        }
      }

      return {
        ok: false,
        problem: `must be a number, got ${describeValue(value)}`
      };
    }
    case 'boolean': {
      if (typeof value === 'boolean') {
        return { ok: true, value };
      }

      const spelled = String(value).trim().toLowerCase();

      if (truthy.includes(spelled)) {
        return { ok: true, value: true };
      }

      if (falsy.includes(spelled)) {
        return { ok: true, value: false };
      }

      return {
        ok: false,
        problem: `must be true or false, got ${describeValue(value)}`
      };
    }
    case 'array': {
      // a single value where a list belongs, or a list that arrived as JSON in
      // a string - both mean the one obvious thing
      const unwrapped = reparse(value);
      const list = Array.isArray(unwrapped) ? unwrapped : [unwrapped];

      if (!items) {
        return { ok: true, value: list };
      }

      const coerced: unknown[] = [];

      for (const [index, entry] of list.entries()) {
        const result = coerce(entry, items);

        if (!result.ok) {
          return {
            ok: false,
            problem: `must be an array of ${items} - entry ${index + 1} ${result.problem}`
          };
        }

        coerced.push(result.value);
      }

      return { ok: true, value: coerced };
    }
    case 'object': {
      const unwrapped = reparse(value);

      if (
        unwrapped &&
        typeof unwrapped === 'object' &&
        !Array.isArray(unwrapped)
      ) {
        return { ok: true, value: unwrapped };
      }

      return {
        ok: false,
        problem: `must be an object, got ${describeValue(value)}`
      };
    }
    // a type the schema builder does not know about is not ours to police
    default:
      return { ok: true, value };
  }
};

const explain = (name: string, problems: string[]) =>
  [
    `The ${name} tool was called with invalid arguments:`,
    ...problems.map((problem) => `  - ${problem}`),
    'Call it again with corrected arguments.'
  ].join('\n');

// tool arguments arrive as untyped JSON straight from the model, and a bad one
// would otherwise reach the handler as a crash. anything fixable is fixed here;
// anything else comes back as a message the model can act on
export const validateArgs = (name: string, raw: unknown): Validation => {
  const params = getParameters(name);

  // a tool that declared nothing has nothing to check against
  if (!params) {
    return { ok: true, args: {} };
  }

  const source = reparse(raw ?? {});

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return {
      ok: false,
      message: explain(name, [
        `arguments must be a JSON object, got ${describeValue(source)}`
      ])
    };
  }

  const supplied = source as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const param of params) {
    const value = supplied[param.name];

    // an empty string is a real answer - patch uses one to delete text - so
    // only an absent value counts as missing
    if (value === undefined || value === null) {
      if (param.required) {
        problems.push(`${param.name} is required (${describeParam(param)})`);
      }

      continue;
    }

    const result = coerce(value, param.type, param.items);

    if (result.ok) {
      args[param.name] = result.value;
    } else {
      problems.push(`${param.name} ${result.problem}`);
    }
  }

  // an invented parameter is harmless once dropped, and bouncing the call over
  // one would cost a turn to fix nothing
  for (const key of Object.keys(supplied)) {
    if (!params.some((param) => param.name === key)) {
      log.debug(`Dropping unknown ${name} parameter ${key}`);
    }
  }

  if (problems.length) {
    return { ok: false, message: explain(name, problems) };
  }

  return { ok: true, args };
};
