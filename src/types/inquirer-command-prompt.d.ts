// inquirer-command-prompt ships no declarations of its own. This covers only
// the members ModeCommandPrompt inherits - the real class has many more, so an
// error here means this shim is incomplete, not that the member is missing.
declare module 'inquirer-command-prompt' {
  export type KeyEvent = {
    key?: {
      name?: string;
      shift?: boolean;
    };
  };

  export default class CommandPrompt {
    constructor(question: unknown, readLine: unknown, answers: unknown);

    rl: { line: string; cursor: number };
    opt: { message: string };

    run(): Promise<unknown>;
    render(): void;
    onKeypress(event: KeyEvent): Promise<void>;
  }
}
