import type { ToolCall } from 'ollama';

import { getLogger } from './logging';
import { getParameters } from '../utils';
import type { ToolParameter, Validation } from '../types';

const log = getLogger('tools');

type Span = { start: number; end: number };

type Recovery = {
  calls: ToolCall[];
  // what the model said around its calls, once the calls themselves are gone
  remainder: string;
};

type Found = { calls: ToolCall[]; spans: Span[] };

type Arguments = ToolCall['function']['arguments'];

const nameKeys = ['name', 'tool', 'tool_name'];
const argKeys = ['arguments', 'parameters', 'args', 'input'];
// a fence written for the user to read - ```ts, ```bash - is never a call
const callFences = ['', 'json', 'tool_call', 'tool_calls', 'tool_code'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
};

// arguments sent as JSON inside a string are unwrapped so the call replays as
// the structured message it should have been. anything that will not parse is
// passed on as it is, for validateArgs to explain to the model
const toArguments = (raw: unknown) => {
  if (typeof raw === 'string') {
    return (parseJson(raw) ?? raw) as Arguments;
  }

  return (raw ?? {}) as Arguments;
};

// every model family spells a call its own way - {name, arguments} for hermes,
// {name, parameters} for llama, {function: {name, arguments}} for anything that
// learned it from openai - and they all mean the same thing
const toCall = (value: unknown): ToolCall | undefined => {
  if (!isRecord(value)) {
    return;
  }

  const inner = isRecord(value.function) ? value.function : value;
  const name =
    typeof value.function === 'string'
      ? value.function
      : nameKeys
          .map((key) => inner[key])
          .find((key) => typeof key === 'string');

  if (typeof name !== 'string' || !name.trim()) {
    return;
  }

  const raw = argKeys.map((key) => inner[key]).find((arg) => arg !== undefined);

  return { function: { name: name.trim(), arguments: toArguments(raw) } };
};

const toCalls = (value: unknown) =>
  (Array.isArray(value) ? value : [value])
    .map(toCall)
    .filter((call): call is ToolCall => !!call);

// qwen's own parser takes exactly one newline off either end of a value - the
// ones that put it on lines of its own - and nothing else, which is what keeps
// indentation and blank lines in a file's content intact
const unwrapValue = (value: string) =>
  value.replace(/^\r?\n/, '').replace(/\r?\n$/, '');

// the earliest of several markers at or after a position, or -1
const nearest = (text: string, from: number, markers: string[]) =>
  markers
    .map((marker) => text.indexOf(marker, from))
    .filter((index) => index !== -1)
    .reduce(
      (first, index) => (first === -1 ? index : Math.min(first, index)),
      -1
    );

const toolCallOpen = '<tool_call>';
const toolCallClose = '</tool_call>';
const functionOpen = '<function=';
const functionClose = '</function>';
const parameterOpen = '<parameter=';
const parameterClose = '</parameter>';

// qwen3.5 and qwen3-coder call tools in XML of their own:
//
//   <tool_call>
//   <function=read>
//   <parameter=path>
//   src/index.ts
//   </parameter>
//   </function>
//   </tool_call>
//
// served through the wrong template, ollama leaves all of that in the reply as
// text. it is scanned rather than matched with a regex because a value can hold
// anything - a file about this very format included - and only a closing tag
// is allowed to end one. generation often stops on the stop token right where
// a closing tag belongs, so a missing one at the end is forgiven
const findXmlCalls = (text: string): Found => {
  const calls: ToolCall[] = [];
  const spans: Span[] = [];
  let position = 0;

  for (;;) {
    const opened = text.indexOf(functionOpen, position);

    if (opened === -1) {
      break;
    }

    const nameEnd = text.indexOf('>', opened);

    if (nameEnd === -1) {
      break;
    }

    const name = text.slice(opened + functionOpen.length, nameEnd).trim();
    const args: Record<string, string> = {};
    let cursor = nameEnd + 1;

    for (;;) {
      while (/\s/.test(text[cursor] ?? '')) {
        cursor++;
      }

      if (text.startsWith(parameterOpen, cursor)) {
        const keyEnd = text.indexOf('>', cursor);

        if (keyEnd === -1) {
          cursor = text.length;
          break;
        }

        const key = text.slice(cursor + parameterOpen.length, keyEnd).trim();
        const valueStart = keyEnd + 1;
        let closed = text.indexOf(parameterClose, valueStart);
        // a parameter opening on a line of its own before the closing tag
        // means this value never got one - one mentioned mid-line is content
        const following = text.indexOf(`\n${parameterOpen}`, valueStart);

        if (following !== -1 && (closed === -1 || following < closed)) {
          closed = -1;
        }

        // without its closing tag a value can only run as far as whatever
        // comes next, or to the end
        const valueEnd =
          closed !== -1
            ? closed
            : nearest(text, valueStart, [
                `\n${parameterOpen}`,
                functionClose,
                toolCallClose
              ]);
        const end = valueEnd === -1 ? text.length : valueEnd;

        args[key] = unwrapValue(text.slice(valueStart, end));
        cursor = closed !== -1 ? closed + parameterClose.length : end;

        continue;
      }

      if (text.startsWith(functionClose, cursor)) {
        cursor += functionClose.length;
        break;
      }

      // something that is not part of the call - a following call, a closing
      // wrapper, or text the model wrote after it - so this call ends here
      const next = nearest(text, cursor, [
        parameterOpen,
        functionClose,
        functionOpen,
        toolCallClose
      ]);

      if (next !== -1 && text.startsWith(parameterOpen, next)) {
        cursor = next;
        continue;
      }

      if (next !== -1 && text.startsWith(functionClose, next)) {
        cursor = next + functionClose.length;
      }

      break;
    }

    // the wrapper belongs to the call, so it goes with it - including the
    // closing tag a template sometimes leaves behind without its opening one
    let start = opened;
    const before = text.slice(0, opened).trimEnd();

    if (before.endsWith(toolCallOpen)) {
      start = before.length - toolCallOpen.length;
    }

    let end = cursor;
    const after = text.slice(cursor);
    const trailing = after.length - after.trimStart().length;

    if (after.trimStart().startsWith(toolCallClose)) {
      end = cursor + trailing + toolCallClose.length;
    }

    if (name) {
      calls.push({ function: { name, arguments: args } });
      spans.push({ start, end });
    }

    position = Math.max(end, opened + 1);
  }

  return { calls, spans };
};

// hermes and qwen2.5 put JSON inside the same tags. these are taken whatever
// they name: the tag leaves no doubt a call was meant, and an unknown name gets
// a reply listing the real ones, which is how the model learns them
const findTaggedCalls = (text: string): Found => {
  const calls: ToolCall[] = [];
  const spans: Span[] = [];
  const pattern = /<tool_call>([\s\S]*?)(?:<\/tool_call>|(?=<tool_call>)|$)/g;

  for (const match of text.matchAll(pattern)) {
    const body = match[1]
      .replace(/^\s*```[\w-]*[ \t]*\r?\n?/, '')
      .replace(/\r?\n?```\s*$/, '');
    const found = toCalls(parseJson(body));

    if (found.length) {
      calls.push(...found);
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  return { calls, spans };
};

// JSON in a fence could just as well be an example written for the user, so
// only a call to a tool that exists counts
const findFencedCalls = (text: string, toolNames: string[]): Found => {
  const calls: ToolCall[] = [];
  const spans: Span[] = [];
  const pattern = /```([\w-]*)[ \t]*\r?\n([\s\S]*?)```/g;

  for (const match of text.matchAll(pattern)) {
    if (!callFences.includes(match[1].toLowerCase())) {
      continue;
    }

    const found = toCalls(parseJson(match[2])).filter((call) =>
      toolNames.includes(call.function.name)
    );

    if (found.length) {
      calls.push(...found);
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  return { calls, spans };
};

// a reply that is nothing but a call. mistral marks its calls with a prefix
// that survives into the text along with them
const findBareCalls = (text: string, toolNames: string[]): Found => {
  const trimmed = text.trim().replace(/^\[TOOL_CALLS\]/, '');
  const calls = toCalls(parseJson(trimmed)).filter((call) =>
    toolNames.includes(call.function.name)
  );

  return {
    calls,
    spans: calls.length ? [{ start: 0, end: text.length }] : []
  };
};

const cut = (text: string, spans: Span[]) => {
  let remainder = '';
  let position = 0;

  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    remainder += text.slice(position, span.start);
    position = Math.max(position, span.end);
  }

  return (remainder + text.slice(position)).trim();
};

// a model that writes its tool calls into its reply instead of making them -
// usually because ollama is serving it with a template whose parser does not
// know its format - would otherwise end the turn on what was really a call.
// the first format that turns anything up wins, so no call is counted twice
export const recoverToolCalls = (
  content: string,
  toolNames: string[]
): Recovery => {
  const finders = [
    findXmlCalls,
    findTaggedCalls,
    (text: string) => findFencedCalls(text, toolNames),
    (text: string) => findBareCalls(text, toolNames)
  ];

  for (const find of finders) {
    const { calls, spans } = find(content);

    if (calls.length) {
      return { calls, remainder: cut(content, spans) };
    }
  }

  return { calls: [], remainder: content };
};

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
