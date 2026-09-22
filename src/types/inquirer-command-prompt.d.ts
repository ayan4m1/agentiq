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

    static addToHistory(context: string, value: string): void;

    rl: { line: string; cursor: number; output: { unmute(): void } };
    opt: { message: string };
    screen: {
      clean(extraLines: number): void;
      height: number;
      extraLinesUnderPrompt: number;
    };

    run(): Promise<unknown>;
    render(): void;
    onKeypress(event: KeyEvent): Promise<void>;
  }
}
