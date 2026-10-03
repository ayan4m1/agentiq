import { readPlan } from '../modules/plan';
import { makeTool } from '../utils';

export const definition = makeTool(
  'read_plan',
  'Returns the most recent plan shown with present_plan. Use it to check the agreed steps while carrying out an approved plan.'
);

export const handler = async () =>
  readPlan() ??
  'There is no saved plan yet - no plan has been presented in this project.';
