// @types/marked-terminal describes the renderer for marked 6-11, and 7.x hands
// back an extension for marked.use() instead. This covers only the options
// modules/markdown.ts passes - the real set has more.
declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  type Style = (text: string) => string;

  export type TerminalRendererOptions = {
    code?: Style;
    blockquote?: Style;
    heading?: Style;
    firstHeading?: Style;
    listitem?: Style;
    paragraph?: Style;
    strong?: Style;
    em?: Style;
    codespan?: Style;
    text?: Style;
    width?: number;
    showSectionPrefix?: boolean;
    reflowText?: boolean;
    tab?: number;
    emoji?: boolean;
  };

  export function markedTerminal(
    options?: TerminalRendererOptions,
    highlightOptions?: Record<string, unknown>
  ): MarkedExtension;
}
