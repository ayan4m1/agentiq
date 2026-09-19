import { getLogger } from '../modules/logging';
import {
  currentContent,
  describeTodoList,
  readRoadmap,
  roadmapName,
  sameTodo,
  serializeRoadmap,
  writeRoadmap
} from '../modules/roadmap';
import { makeParameter, makeTool, renderDiff } from '../utils';

const log = getLogger('add_todo');

export const definition = makeTool(
  'add_todo',
  `Adds an objective to the todo list in ${roadmapName}, the file holding this project's long-term goals. Use it for work that outlives the current conversation, not for the individual steps of a task you are about to finish.`,
  [
    makeParameter(
      'string',
      'text',
      'The objective as one short imperative line, for example "Add a retry with backoff to the fetch tool"'
    )
  ]
);

type Args = {
  text: string;
};

export const handler = async ({ text }: Args) => {
  // a todo is one line of a markdown list, so a newline the model slipped in
  // would split it into a line that parses and one that does not
  const objective = text.replace(/\s+/g, ' ').trim();

  if (!objective) {
    return 'An objective needs some text. Call add_todo again with the objective written out.';
  }

  const before = currentContent();
  const roadmap = readRoadmap();
  const duplicate = roadmap.todos.find(
    (todo) => !todo.done && sameTodo(todo.text, objective)
  );

  // two identical open objectives would make both of them ambiguous to
  // complete_todo forever after, so the list is kept unique by construction
  if (duplicate) {
    log.debug('Objective is already on the list');

    return `"${duplicate.text}" is already on the todo list, so nothing was added.\n\n${describeTodoList(roadmap.todos)}`;
  }

  const repeat = roadmap.todos.find(
    (todo) => todo.done && sameTodo(todo.text, objective)
  );
  const updated = {
    ...roadmap,
    todos: [...roadmap.todos, { text: objective, done: false }]
  };

  // these tools deliberately skip requestApproval - the roadmap is the model's
  // own bookkeeping rather than the user's code, and confirming every checkbox
  // would be unusable. the diff is what keeps the writes from being invisible
  renderDiff(roadmapName, before, serializeRoadmap(updated));
  writeRoadmap(updated);

  log.info(`Added an objective to ${roadmapName}`);

  return [
    `Added "${objective}" to the todo list.`,
    // worth saying rather than refusing - the same objective coming back may be
    // a regression, and the model is better placed than this tool to judge
    repeat
      ? `The same objective was completed before${repeat.doneAt ? ` on ${repeat.doneAt}` : ''}.`
      : undefined,
    describeTodoList(updated.todos)
  ]
    .filter(Boolean)
    .join('\n\n');
};
