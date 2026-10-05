import chalk from 'chalk';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// the reply keeps the blue it has always been printed in, so it still stands
// apart from tool output and logs - markdown only adds to it
const renderer = new Marked(
  markedTerminal({
    paragraph: chalk.blue,
    listitem: chalk.blue,
    showSectionPrefix: false,
    reflowText: false,
    tab: 2,
    // models write :colon: words in code and prose that are not emoji
    emoji: false
  })
);

// marked-terminal closes every block with blank lines of its own, which would
// double the spacing the model already wrote
export const renderMarkdown = (source: string) =>
  (renderer.parse(source, { async: false }) as string).replace(/\n+$/, '');

const renderInline = (source: string) =>
  renderer.parseInline(source, { async: false }) as string;

const fenceOpen = /^\s*(`{3,}|~{3,})/;
const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const quote = /^\s*>\s?(.*)$/;
const isTableRow = (line: string) => line.trimStart().startsWith('|');

// one line of everything that is not held as a block. lists and quotes are
// drawn here rather than by marked, which sees each line as a list of its own -
// numbering every item 1. - and leaves the markup inside an item unrendered.
// the line's own indent is kept, both to nest list items and so that a
// continuation line is not read as indented code
const renderLine = (line: string) => {
  const item = listItem.exec(line);

  if (item) {
    const [, indent, marker, text] = item;
    const bullet = /\d/.test(marker) ? marker : '•';

    return `${indent}${bullet} ${chalk.blue(renderInline(text))}`;
  }

  const quoted = quote.exec(line);

  if (quoted) {
    return chalk.gray(`│ ${chalk.italic(renderInline(quoted[1]))}`);
  }

  const indent = /^\s*/.exec(line)![0];

  return `${indent}${renderMarkdown(line.slice(indent.length))}`;
};

// renders a reply as it streams. a line is only printed once its newline
// arrives, since the markers that decide how it looks can be anywhere in it.
// fenced code and tables are held whole, because a block cannot be highlighted
// or a column sized from a part of it
export const createMarkdownStream = (write: (text: string) => void) => {
  let pending = '';
  let fence: string | undefined;
  let table: string[] | undefined;
  let block: string[] = [];

  const writeBlock = (lines: string[]) =>
    write(`${renderMarkdown(lines.join('\n'))}\n`);

  const handleLine = (line: string) => {
    if (fence) {
      block.push(line);

      const trimmed = line.trim();

      // a closing fence is the same character, at least as long, and nothing
      // else on the line
      if (
        trimmed.length >= fence.length &&
        trimmed === trimmed[0].repeat(trimmed.length) &&
        trimmed[0] === fence[0]
      ) {
        writeBlock(block);
        fence = undefined;
        block = [];
      }

      return;
    }

    if (table) {
      if (isTableRow(line)) {
        table.push(line);

        return;
      }

      writeBlock(table);
      table = undefined;
    }

    const opened = fenceOpen.exec(line);

    if (opened) {
      fence = opened[1];
      block = [line];
    } else if (isTableRow(line)) {
      table = [line];
    } else if (!line.trim()) {
      write('\n');
    } else {
      write(`${renderLine(line)}\n`);
    }
  };

  const push = (text: string) => {
    pending += text;

    let newline = pending.indexOf('\n');

    while (newline !== -1) {
      handleLine(pending.slice(0, newline).replace(/\r$/, ''));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  };

  // the end of a turn, or an interrupt - whatever is still held is printed as
  // it stands, an unclosed fence included, so nothing the model said is lost.
  // everything written ends on a newline, so the cursor is left on a fresh line
  const flush = () => {
    const last = pending;

    pending = '';

    if (last) {
      handleLine(last);
    }

    if (fence) {
      writeBlock(block);
      fence = undefined;
      block = [];
    }

    if (table) {
      writeBlock(table);
      table = undefined;
    }
  };

  return { push, flush };
};
