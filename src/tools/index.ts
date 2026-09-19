import * as patch from './patch';
import * as read from './read';
import * as write from './write';
import * as find from './find';
import * as list from './list';
import * as fetch from './fetch';
import * as shell from './shell';
import * as askList from './ask_list';
import * as askBoolean from './ask_boolean';
import * as presentPlan from './present_plan';
import * as runBackground from './run_background';
import * as readJob from './read_job';
import * as stopJob from './stop_job';
import * as addTodo from './add_todo';
import * as completeTodo from './complete_todo';
import * as removeTodo from './remove_todo';
import * as updateNotes from './update_notes';

import type { ToolCall } from '../types';

export const tools: ToolCall[] = [
  read,
  write,
  patch,
  find,
  list,
  fetch,
  shell,
  runBackground,
  readJob,
  stopJob,
  askList,
  askBoolean,
  presentPlan,
  addTodo,
  completeTodo,
  removeTodo,
  updateNotes
];
