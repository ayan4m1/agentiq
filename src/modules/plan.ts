import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// kept beside the code like ROADMAP.md, so the plan outlives the session that
// made it and whoever picks the work up next can see what was agreed
export const planName = 'PLAN.md';
export const planPath = resolve(process.cwd(), planName);

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
export const writePlan = (plan: Plan) =>
  writeFileSync(planPath, serializePlan(plan));

export const readPlan = () =>
  existsSync(planPath) ? readFileSync(planPath).toString() : undefined;
