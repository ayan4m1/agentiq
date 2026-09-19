import { getLogger } from '../modules/logging';
import {
  currentContent,
  describeTodoList,
  findTodo,
  readRoadmap,
  roadmapName,
  serializeRoadmap,
  writeRoadmap
} from '../modules/roadmap';
import { makeParameter, makeTool, renderDiff } from '../utils';

const log = getLogger('complete_todo');

export const definition = makeTool(
  'complete_todo',
  `Marks an objective on the ${roadmapName} todo list as done. It stays in the file, checked off, as a record of what this project has already accomplished.`,
  [
    makeParameter(
      'string',
      'todo',
      'The number of the objective in the list, or enough of its wording to identify exactly one'
    )
  ]
);

type Args = {
  todo: string;
};

export const handler = async ({ todo }: Args) => {
  const before = currentContent();
  const roadmap = readRoadmap();

  if (!roadmap.todos.length) {
    return `The todo list in ${roadmapName} is empty, so there was nothing to mark off.`;
  }

  if (roadmap.todos.every((entry) => entry.done)) {
    return `Every objective in ${roadmapName} is already complete, so there was nothing to mark off. Use add_todo if there is new work to record.`;
  }

  // the whole list is searched rather than just the open items, so a number
  // means the same position here as it does everywhere else
  const found = findTodo(roadmap.todos, todo);

  if (typeof found === 'string') {
    return `${found}\n\n${describeTodoList(roadmap.todos)}`;
  }

  if (found.done) {
    return `"${found.text}" was already marked complete, so nothing was changed.\n\n${describeTodoList(roadmap.todos)}`;
  }

  // dates are stamped in utc, which can read as tomorrow late in the evening -
  // the day a thing was finished is granular enough for a roadmap either way
  const doneAt = new Date().toISOString().slice(0, 10);
  const updated = {
    ...roadmap,
    // findTodo handed back one of these objects, so identity picks out the one
    // that matched without needing a position to be carried alongside it
    todos: roadmap.todos.map((entry) =>
      entry === found ? { ...entry, done: true, doneAt } : entry
    )
  };

  renderDiff(roadmapName, before, serializeRoadmap(updated));
  writeRoadmap(updated);

  log.info(`Completed an objective in ${roadmapName}`);

  return `Marked "${found.text}" as done.\n\n${describeTodoList(updated.todos)}`;
};
