import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { home } from './config';
import { slugFor } from '../utils';

// beside the sessions and approvals rather than in the project: present_plan
// saves the plan before anyone has approved anything - in plan mode, and in an
// unattended exec run - so it must not write to the user's working tree. keyed
// by the project, so the plan still outlives the session that made it
export const planPath = resolve(home, 'plans', `${slugFor(process.cwd())}.md`);

export type Plan = {
  title: string;
  steps: string[];
};

// numbered the same way present_plan prints it, so a step the user approved as
// "3." is still step 3 when the model reads it back. a plan with no steps is
// just its title, rather than a title trailed by an empty block
export const serializePlan = ({ title, steps }: Plan) =>
  [
    `# ${title}`,
    ...(steps.length
      ? [steps.map((step, index) => `${index + 1}. ${step}`).join('\n')]
      : [])
  ].join('\n\n') + '\n';

// only the latest plan matters, so each one replaces the last
export const writePlan = (plan: Plan) => {
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, serializePlan(plan));
};

export const readPlan = () =>
  existsSync(planPath) ? readFileSync(planPath).toString() : undefined;
