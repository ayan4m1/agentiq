import * as patch from './patch';
import * as read from './read';
import * as write from './write';

import { ToolCall } from '../types';

export const tools: ToolCall[] = [read, write, patch];
