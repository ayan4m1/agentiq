import * as patch from './patch';
import * as read from './read';
import * as write from './write';
import * as find from './find';
import * as list from './list';
import * as fetch from './fetch';
import * as explore from './explore';
import * as shell from './shell';
import * as askList from './ask_list';
import * as askBoolean from './ask_boolean';
import * as presentPlan from './present_plan';
import * as readPlan from './read_plan';
import * as startJob from './start_job';
import * as readJob from './read_job';
import * as stopJob from './stop_job';
import * as addTodo from './add_todo';
import * as completeTodo from './complete_todo';
import * as removeTodo from './remove_todo';
import * as updateNotes from './update_notes';

import {
  explore as exploreConfig,
  roadmap as roadmapConfig
} from '../modules/config';
import type { ToolCall } from '../types';

// offered only when AQ_ENABLE_ROADMAP is set - a model that cannot see them has
// no way to write ROADMAP.md
const roadmapTools: ToolCall[] = [
  addTodo,
  completeTodo,
  removeTodo,
  updateNotes
];

export const tools: ToolCall[] = [
  read,
  write,
  patch,
  find,
  list,
  fetch,
  shell,
  startJob,
  readJob,
  stopJob,
  askList,
  askBoolean,
  presentPlan,
  readPlan,
  ...(exploreConfig.enabled ? [explore] : []),
  ...(roadmapConfig.enabled ? roadmapTools : [])
];

// tools that only exist once agentiq is running - those of the MCP servers it
// connected to. added to the same list rather than kept apart, so that dispatch
// and token counting find them without knowing where they came from. it has
// to happen before makeThinker(), which reads the list once
export const registerTools = (extra: ToolCall[]) => {
  tools.push(...extra);
};
