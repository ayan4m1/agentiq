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
import * as decide from './decide';

import {
  decide as decideConfig,
  explore as exploreConfig,
  provider as providerConfig,
  roadmap as roadmapConfig
} from '../modules/config';
import { isMcpTool } from '../modules/mcp';
import { Provider, type ToolCall } from '../types';

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
  ...(roadmapConfig.enabled ? roadmapTools : []),
  // System One is ollama's alone, and needs a decision model of its own to ask
  ...(providerConfig.name === Provider.Ollama && decideConfig.model
    ? [decide]
    : [])
];

// tools that only exist once agentiq is running - those of the MCP servers it
// is connected to. kept in the same list rather than apart, so that dispatch
// and token counting find them without knowing where they came from. the list
// is changed in place, since the thinker holds on to it - and reads it again
// in rebuild(), which has to follow any change after makeThinker()
export const setMcpTools = (extra: ToolCall[]) => {
  const builtIn = tools.filter(
    (tool) => !isMcpTool(tool.definition.function.name)
  );

  tools.splice(0, tools.length, ...builtIn, ...extra);
};
