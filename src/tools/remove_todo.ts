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

const log = getLogger('remove_todo');

export const definition = makeTool(
  'remove_todo',
  `Deletes an objective from ${roadmapName} outright. Use this only when an objective was a mistake, a duplicate, or is no longer wanted - if it was actually accomplished, use complete_todo so it stays on the record.`,
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
    return `The todo list in ${roadmapName} is empty, so there was nothing to remove.`;
  }

  const found = findTodo(roadmap.todos, todo);

  if (typeof found === 'string') {
    return `${found}\n\n${describeTodoList(roadmap.todos)}`;
  }

  const updated = {
    ...roadmap,
    todos: roadmap.todos.filter((entry) => entry !== found)
  };

  renderDiff(roadmapName, before, serializeRoadmap(updated));
  writeRoadmap(updated);

  log.info(`Removed an objective from ${roadmapName}`);

  return [
    `Deleted "${found.text}" from the roadmap.`,
    // completing something is the only record this project keeps of having done
    // it, so say plainly when a delete has just thrown that record away
    found.done
      ? 'It was already marked done, so that record is gone.'
      : undefined,
    describeTodoList(updated.todos)
  ]
    .filter(Boolean)
    .join('\n\n');
};
