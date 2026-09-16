import * as patch from './patch';
import * as read from './read';
import * as write from './write';
import * as find from './find';
import * as fetch from './fetch';
import * as shell from './shell';
import * as askList from './ask_list';
import * as presentPlan from './present_plan';

import { ToolCall } from '../types';

export const tools: ToolCall[] = [
  read,
  write,
  patch,
  find,
  fetch,
  shell,
  askList,
  presentPlan
];
