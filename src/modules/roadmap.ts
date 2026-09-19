import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { getContentBudget, truncate } from '../utils';

// the roadmap lives beside the code it describes rather than under ~/.agentiq
// like sessions do - it is the project's memory, so it belongs to the project
export const roadmapName = 'ROADMAP.md';
export const roadmapPath = resolve(process.cwd(), roadmapName);

const defaultTitle = '# Roadmap';
const todoHeading = '## Todo';
const notesHeading = '## Notes';
// said in the file itself because whoever opens it next is as likely to be a
// person as a model, and a person will want to know what rewrites it
const banner = `<!-- agentiq: long-term memory. Leave the "${todoHeading}" and "${notesHeading}" headings in place. -->`;

// only the copy pasted into the system prompt is capped - the file keeps
// everything, which is the entire point of having it. the fraction is far below
// the 0.3 the read tool uses because this text is resent on every single turn
const promptBudget = getContentBudget(0.05);

export const notesBudget = promptBudget;

// a project that has been running for a year has hundreds of finished
// objectives, and the model needs the recent ones rather than all of them
const completedInPrompt = 20;

export type Todo = {
  text: string;
  done: boolean;
  // kept in an html comment so it survives a round trip without showing up in
  // the rendered markdown or in the text a todo is identified by
  doneAt?: string;
};

export type Roadmap = {
  // preserved rather than rewritten - someone who titled their file "# Plans"
  // did not ask for it to be renamed
  title: string;
  // free text between the title and the first section, put back where it was
  preamble: string;
  todos: Todo[];
  notes: string;
  // sections and stray lines the tools do not manage, carried through verbatim
  // below the ones they do
  extra: string;
  // whatever the file on disk already used, so a write on a checkout with crlf
  // endings does not come back as a diff of every line
  eol: string;
};

const itemPattern = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/;
const donePattern = /\s*<!--\s*done\s+(.+?)\s*-->\s*$/;
const sectionPattern = /^##\s+(.+?)\s*$/;
const titlePattern = /^#\s+\S/;
const bannerPattern = /^\s*<!--\s*agentiq:/;
const datePattern = /^[\d-]{4,10}$/;
const digitsPattern = /^\d+$/;

// text is compared this way everywhere - matching a todo, spotting a duplicate
// - so capitalisation and stray spacing never decide the answer
const flatten = (text: string) =>
  text.trim().replace(/\s+/g, ' ').toLowerCase();

export const sameTodo = (left: string, right: string) =>
  flatten(left) === flatten(right);

// blank lines at the edges of a block are an artefact of where the headings
// were, not content, and keeping them makes every write grow the file
const trimBlock = (lines: string[]) =>
  lines.join('\n').replace(/^\n+|\s+$/g, '');

const emptyRoadmap = (): Roadmap => ({
  title: defaultTitle,
  preamble: '',
  todos: [],
  notes: '',
  extra: '',
  eol: '\n'
});

export const parseRoadmap = (content: string): Roadmap => {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  // splitting on both means the rest of this file only ever sees \n, and the
  // serializer is the single place the line ending is decided
  const lines = content.split(/\r?\n/);
  const preamble: string[] = [];
  const todos: Todo[] = [];
  const notes: string[] = [];
  const extra: string[] = [];
  let title = defaultTitle;
  let titled = false;
  // where the lines after the last heading belong - nothing before the first
  // "## " heading is part of a section
  let section: 'preamble' | 'todo' | 'notes' | 'extra' = 'preamble';

  for (const line of lines) {
    const heading = sectionPattern.exec(line);

    if (heading) {
      const name = flatten(heading[1]);

      if (name === 'todo' || name === 'todos') {
        section = 'todo';
      } else if (name === 'notes' || name === 'note') {
        section = 'notes';
      } else {
        // a section of someone else's making is not ours to rewrite, so the
        // heading goes through with everything under it
        section = 'extra';
        extra.push(line);
      }

      continue;
    }

    if (section === 'preamble') {
      if (!titled && titlePattern.test(line)) {
        title = line.trim();
        titled = true;
        continue;
      }

      // the banner is re-emitted on every write, so keeping a copy here would
      // stack a second one up each time
      if (!bannerPattern.test(line)) {
        preamble.push(line);
      }

      continue;
    }

    if (section === 'notes') {
      notes.push(line);
      continue;
    }

    if (section === 'extra') {
      extra.push(line);
      continue;
    }

    const item = itemPattern.exec(line);

    if (!item) {
      // prose under the todo heading is not a todo, and dropping it would lose
      // a hand-written note - it moves rather than dies
      if (line.trim()) {
        extra.push(line);
      }

      continue;
    }

    const [, box, rest] = item;
    const stamp = donePattern.exec(rest)?.[1];

    todos.push({
      text: rest.replace(donePattern, '').trim(),
      done: box.toLowerCase() === 'x',
      // a hand-typed "done last tuesday" would otherwise be echoed back into
      // the file forever
      doneAt: stamp && datePattern.test(stamp) ? stamp : undefined
    });
  }

  return {
    title,
    preamble: trimBlock(preamble),
    todos,
    notes: trimBlock(notes),
    extra: trimBlock(extra),
    eol
  };
};

const renderLine = ({ text, done, doneAt }: Todo) =>
  `- [${done ? 'x' : ' '}] ${text}${done && doneAt ? ` <!-- done ${doneAt} --> ` : ''}`.trimEnd();

// the file keeps its items in the order they were written, completed or not.
// sinking finished work to the bottom would read better, but a todo can be
// identified by its number, and reordering would silently repoint every number
// the model is holding from an earlier turn
export const serializeRoadmap = ({
  title,
  preamble,
  todos,
  notes,
  extra,
  eol
}: Roadmap) => {
  const blocks = [title, banner];

  if (preamble) {
    blocks.push(preamble);
  }

  // the headings are emitted whether or not there is anything under them - an
  // empty section is what tells the next writer where its content goes
  blocks.push(todoHeading);

  if (todos.length) {
    blocks.push(todos.map(renderLine).join('\n'));
  }

  blocks.push(notesHeading);

  if (notes) {
    blocks.push(notes);
  }

  if (extra) {
    blocks.push(extra);
  }

  return `${blocks.join('\n\n')}\n`.replace(/\n/g, eol);
};

// an unreadable roadmap is a real failure and belongs to the dispatch loop in
// modules/ollama.ts, but an absent one is the ordinary first run
export const readRoadmap = (): Roadmap =>
  existsSync(roadmapPath)
    ? parseRoadmap(readFileSync(roadmapPath).toString())
    : emptyRoadmap();

export const writeRoadmap = (roadmap: Roadmap) =>
  writeFileSync(roadmapPath, serializeRoadmap(roadmap));

// what the file looks like right now, for the diff every roadmap tool prints -
// there is no approval prompt on these, so the diff is the whole account the
// user gets of what changed
export const currentContent = () =>
  existsSync(roadmapPath) ? readFileSync(roadmapPath).toString() : '';

// numbered the same way everywhere - in the file, in the system prompt and in
// every tool result - so a number the model reads anywhere means the same line
export const renderTodos = (todos: Todo[], completedShown = Infinity) => {
  if (!todos.length) {
    return '(the todo list is empty)';
  }

  const done = todos.filter((todo) => todo.done);
  const hidden = Math.max(done.length - completedShown, 0);
  // the oldest completed items are the ones dropped, and they are dropped by
  // identity rather than by position so the numbering never shifts
  const dropped = new Set(done.slice(0, hidden));
  const lines = todos
    .map((todo, index) => ({ todo, number: index + 1 }))
    .filter(({ todo }) => !dropped.has(todo))
    .map(
      ({ todo, number }) =>
        `${String(number).padStart(3)}. [${todo.done ? 'x' : ' '}] ${todo.text}${
          todo.done && todo.doneAt ? ` (done ${todo.doneAt})` : ''
        }`
    );

  if (hidden > 0) {
    lines.unshift(
      `     (${hidden} older completed objective(s) omitted - they are in ${roadmapName})`
    );
  }

  return lines.join('\n');
};

// the copy in the system prompt was taken at startup and never changes, so the
// freshest list the model has is whatever the last tool call handed back -
// every roadmap tool ends with this
export const describeTodoList = (todos: Todo[]) =>
  `The todo list is now:\n\n${renderTodos(todos)}`;

// resolve the todo a tool was asked to act on, by number or by wording. returns
// the item, or a sentence explaining why it could not be identified - the patch
// tool's rule applied to a list, since no match and the wrong match are both
// worse than one more turn spent saying which one
export const findTodo = (todos: Todo[], target: string): Todo | string => {
  const wanted = flatten(target);

  if (!wanted) {
    return 'No objective was named, so nothing was changed. Pass the number of the objective or enough of its wording to identify it.';
  }

  if (digitsPattern.test(wanted)) {
    const index = Number(wanted) - 1;

    if (index < 0 || index >= todos.length) {
      return `There is no objective number ${wanted} - the list has ${todos.length}. Use a number from the list, or enough of an objective's wording to identify it.`;
    }

    return todos[index];
  }

  // an exact match wins outright, so "add tests" is not ambiguous merely
  // because "add tests for the roadmap parser" is also on the list
  const exact = todos.filter((todo) => flatten(todo.text) === wanted);
  const matches = exact.length
    ? exact
    : todos.filter((todo) => flatten(todo.text).includes(wanted));

  if (!matches.length) {
    return `No objective matches "${target}", so nothing was changed. Copy the wording from the list, or use its number.`;
  }

  if (matches.length > 1) {
    return [
      `${matches.length} objectives match "${target}", so nothing was changed. Use more of the wording of the one you meant, or its number:`,
      ...matches.map((todo) => `  ${todos.indexOf(todo) + 1}. ${todo.text}`)
    ].join('\n');
  }

  return matches[0];
};

// the standing block appended to the system prompt at startup
export const describeRoadmap = () => {
  const { todos, notes } = readRoadmap();

  // an empty or absent roadmap is not worth a heading in the prompt - the tool
  // descriptions already tell the model the file is there to be written
  if (!todos.length && !notes) {
    return;
  }

  return truncate(
    [
      '## Project roadmap',
      `${roadmapName} holds this project's long-term goals and notes, reproduced below as it stood when this session started. It does not update itself - keep it current with add_todo, complete_todo, remove_todo and update_notes, each of which hands back the current list.`,
      '### Todo',
      renderTodos(todos, completedInPrompt),
      ...(notes ? ['### Notes', notes] : [])
    ].join('\n\n'),
    promptBudget
  );
};
