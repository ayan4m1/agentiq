import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';

import type { Roadmap, Todo } from './roadmap';

// the roadmap path is resolved from the working directory when the module
// loads, so it has to be imported from inside the scratch project
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-roadmap-'));
const original = process.cwd();

process.chdir(root);

const {
  currentContent,
  describeRoadmap,
  describeTodoList,
  findTodo,
  notesBudget,
  parseRoadmap,
  readRoadmap,
  renderTodos,
  roadmapName,
  roadmapPath,
  sameTodo,
  serializeRoadmap,
  writeRoadmap
} = await import('./roadmap');

process.chdir(original);

// spelled out again rather than exported, because a test that read the banner
// from the module could not tell if it had changed
const banner =
  '<!-- agentiq: long-term memory. Leave the "## Todo" and "## Notes" headings in place. -->';

// one document with every part of the shape in it, for the round trips
const fixture = [
  '# Plans',
  '',
  'Intro text.',
  '',
  '## Todo',
  '',
  '- [ ] First',
  '- [x] Second <!-- done 2026-09-22 -->',
  '',
  '## Notes',
  '',
  'Remember this.',
  '',
  '## Other',
  '',
  'Keep me.',
  ''
].join('\n');

const read = () => readFileSync(roadmapPath).toString();

// every todo is a fresh object: renderTodos hides completed items by identity
// and findTodo reports their positions with indexOf, so shared references would
// behave differently here than a list read off disk does
const todo = (text: string, done = false, doneAt?: string): Todo => ({
  text,
  done,
  doneAt
});

beforeEach(() => {
  rmSync(roadmapPath, { force: true });
});

describe('parseRoadmap', () => {
  test('gives an empty document the default shape', () => {
    assert.deepEqual(parseRoadmap(''), {
      title: '# Roadmap',
      preamble: '',
      todos: [],
      notes: '',
      extra: '',
      eol: '\n'
    });
  });

  test('takes the first heading as the title', () => {
    assert.equal(parseRoadmap('# Plans\n\n## Todo\n').title, '# Plans');
  });

  test('keeps a second level one heading as preamble text', () => {
    // someone who titled their file "# Plans" did not ask for a rename, and
    // only the first heading is the title
    const { title, preamble } = parseRoadmap('# Plans\n\n# Later\n\n## Todo\n');

    assert.equal(title, '# Plans');
    assert.equal(preamble, '# Later');
  });

  test('keeps the text between the title and the first section', () => {
    const { preamble } = parseRoadmap('# Roadmap\n\nIntro text.\n\n## Todo\n');

    assert.equal(preamble, 'Intro text.');
  });

  test('drops the banner so a rewrite does not stack a second one', () => {
    const { preamble } = parseRoadmap(
      `# Roadmap\n\n${banner}\n\nIntro text.\n\n## Todo\n`
    );

    assert.equal(preamble, 'Intro text.');
  });

  test('notices crlf endings', () => {
    assert.equal(parseRoadmap('# Roadmap\r\n\r\n## Todo\r\n').eol, '\r\n');
  });

  test('assumes lf endings otherwise', () => {
    assert.equal(parseRoadmap('# Roadmap\n\n## Todo\n').eol, '\n');
  });

  for (const heading of ['## Todo', '## Todos', '##   TODO', '## todos']) {
    test(`reads "${heading}" as the todo section`, () => {
      const { todos, extra } = parseRoadmap(
        `# Roadmap\n\n${heading}\n\n- [ ] First\n`
      );

      assert.deepEqual(todos, [
        { text: 'First', done: false, doneAt: undefined }
      ]);
      assert.equal(extra, '');
    });
  }

  for (const heading of ['## Notes', '## Note', '## NOTES']) {
    test(`reads "${heading}" as the notes section`, () => {
      const { notes, extra } = parseRoadmap(
        `# Roadmap\n\n${heading}\n\nRemember this.\n`
      );

      assert.equal(notes, 'Remember this.');
      assert.equal(extra, '');
    });
  }

  test('carries an unmanaged section through with its heading', () => {
    const { notes, extra } = parseRoadmap(
      '# Roadmap\n\n## Notes\n\nA note.\n\n## Other\n\nKeep me.\n'
    );

    assert.equal(notes, 'A note.');
    assert.equal(extra, '## Other\n\nKeep me.');
  });

  test('leaves deeper headings inside the section they sit in', () => {
    // update_notes demotes what it writes to level three precisely so that a
    // heading in a note cannot end the notes section
    const { notes, extra } = parseRoadmap(
      '# Roadmap\n\n## Notes\n\n### Decisions\n\nUse tabs.\n'
    );

    assert.equal(notes, '### Decisions\n\nUse tabs.');
    assert.equal(extra, '');
  });

  const items: [string, Todo][] = [
    ['- [ ] First', { text: 'First', done: false, doneAt: undefined }],
    ['* [ ] First', { text: 'First', done: false, doneAt: undefined }],
    ['- [x] First', { text: 'First', done: true, doneAt: undefined }],
    ['- [X] First', { text: 'First', done: true, doneAt: undefined }],
    ['   - [ ]   First', { text: 'First', done: false, doneAt: undefined }]
  ];

  for (const [line, expected] of items) {
    test(`reads "${line}" as an item`, () => {
      const { todos } = parseRoadmap(`# Roadmap\n\n## Todo\n\n${line}\n`);

      assert.deepEqual(todos, [expected]);
    });
  }

  test('lifts a done stamp out of the text', () => {
    const { todos } = parseRoadmap(
      '# Roadmap\n\n## Todo\n\n- [x] Ship it <!-- done 2026-09-22 -->\n'
    );

    assert.deepEqual(todos, [
      { text: 'Ship it', done: true, doneAt: '2026-09-22' }
    ]);
  });

  test('discards a stamp that is not a date', () => {
    // a hand-typed "done last tuesday" would otherwise be echoed back into the
    // file forever
    const { todos } = parseRoadmap(
      '# Roadmap\n\n## Todo\n\n- [x] Ship it <!-- done last tuesday -->\n'
    );

    assert.deepEqual(todos, [
      { text: 'Ship it', done: true, doneAt: undefined }
    ]);
  });

  test('moves prose under the todo heading rather than dropping it', () => {
    const { todos, extra } = parseRoadmap(
      '# Roadmap\n\n## Todo\n\nA hand-written note.\n\n- [ ] First\n'
    );

    assert.deepEqual(
      todos.map(({ text }) => text),
      ['First']
    );
    assert.equal(extra, 'A hand-written note.');
  });
});

describe('serializeRoadmap', () => {
  const document = (over: Partial<Roadmap> = {}): Roadmap => ({
    title: '# Roadmap',
    preamble: '',
    todos: [],
    notes: '',
    extra: '',
    eol: '\n',
    ...over
  });

  test('emits both headings even with nothing under them', () => {
    // an empty section is what tells the next writer where its content goes
    assert.equal(
      serializeRoadmap(document()),
      `# Roadmap\n\n${banner}\n\n## Todo\n\n## Notes\n`
    );
  });

  test('lays a full document out in order', () => {
    const text = serializeRoadmap(
      document({
        title: '# Plans',
        preamble: 'Intro text.',
        todos: [todo('First'), todo('Second', true, '2026-09-22')],
        notes: 'Remember this.',
        extra: '## Other\n\nKeep me.'
      })
    );

    assert.equal(
      text,
      `# Plans\n\n${banner}\n\nIntro text.\n\n## Todo\n\n- [ ] First\n- [x] Second <!-- done 2026-09-22 -->\n\n## Notes\n\nRemember this.\n\n## Other\n\nKeep me.\n`
    );
  });

  test('leaves a completed item with no stamp unpadded', () => {
    const text = serializeRoadmap(document({ todos: [todo('First', true)] }));

    assert.match(text, /- \[x\] First\n/);
    assert.doesNotMatch(text, /[ \t]\n/);
  });

  test('writes crlf throughout when that is what the file used', () => {
    const text = serializeRoadmap(
      document({ todos: [todo('First')], eol: '\r\n' })
    );

    // a stray lf would come back as a diff of every line below it
    assert.doesNotMatch(text, /[^\r]\n/);
    assert.match(text, /- \[ \] First\r\n/);
  });

  test('round trips a document it parsed', () => {
    const parsed = parseRoadmap(fixture);

    assert.deepEqual(parseRoadmap(serializeRoadmap(parsed)), parsed);
  });

  test('writes the same bytes the second time', () => {
    const once = serializeRoadmap(parseRoadmap(fixture));

    assert.equal(serializeRoadmap(parseRoadmap(once)), once);
  });
});

describe('sameTodo', () => {
  const pairs: [string, string, boolean][] = [
    ['Write the parser', 'write the parser', true],
    ['Write  the   parser', 'Write the parser', true],
    ['  Write the parser  ', 'Write the parser', true],
    ['Write the parser', 'Write the serializer', false],
    ['Write the parser', 'Write the parser now', false]
  ];

  for (const [left, right, expected] of pairs) {
    test(`${expected ? 'matches' : 'separates'} "${left}" and "${right}"`, () => {
      assert.equal(sameTodo(left, right), expected);
    });
  }
});

describe('renderTodos', () => {
  test('says so when the list is empty', () => {
    assert.equal(renderTodos([]), '(the todo list is empty)');
  });

  test('numbers from one and right aligns the numbers', () => {
    const todos = Array.from({ length: 10 }, (_, index) =>
      todo(`Item ${index + 1}`)
    );
    const lines = renderTodos(todos).split('\n');

    assert.equal(lines[0], '  1. [ ] Item 1');
    assert.equal(lines[9], ' 10. [ ] Item 10');
  });

  test('shows the completion date when there is one', () => {
    assert.equal(
      renderTodos([todo('First', true, '2026-09-22')]),
      '  1. [x] First (done 2026-09-22)'
    );
  });

  test('leaves a completed item with no date bare', () => {
    assert.equal(renderTodos([todo('First', true)]), '  1. [x] First');
  });

  test('omits the oldest completed items without moving the numbers', () => {
    const todos = [
      todo('Old one', true, '2026-09-01'),
      todo('Open one'),
      todo('Old two', true, '2026-09-02'),
      todo('Recent', true, '2026-09-03')
    ];

    const lines = renderTodos(todos, 1).split('\n');

    assert.equal(
      lines[0],
      `     (2 older completed objective(s) omitted - they are in ${roadmapName})`
    );
    // a number the model read in an earlier turn still has to mean this line
    assert.equal(lines[1], '  2. [ ] Open one');
    assert.equal(lines[2], '  4. [x] Recent (done 2026-09-03)');
    assert.equal(lines.length, 3);
  });

  test('says nothing about omissions when they all fit', () => {
    const text = renderTodos([todo('First', true), todo('Second')], 5);

    assert.doesNotMatch(text, /omitted/);
  });
});

describe('describeTodoList', () => {
  test('introduces the list it renders', () => {
    assert.equal(
      describeTodoList([todo('First')]),
      'The todo list is now:\n\n  1. [ ] First'
    );
  });

  test('keeps every completed item, unlike the system prompt copy', () => {
    const todos = Array.from({ length: 25 }, (_, index) =>
      todo(`Item ${index + 1}`, true)
    );

    assert.doesNotMatch(describeTodoList(todos), /omitted/);
  });

  test('reports an empty list rather than nothing at all', () => {
    assert.match(describeTodoList([]), /\(the todo list is empty\)/);
  });
});

describe('findTodo', () => {
  const todos = [
    todo('Write the parser'),
    todo('Add tests'),
    todo('Add tests for the roadmap parser'),
    todo('Ship it', true, '2026-09-22')
  ];

  // the refusals are the interesting half of this function, so they are read
  // back as strings rather than asserted on the union
  const messageFrom = (list: Todo[], target: string) => {
    const result = findTodo(list, target);

    assert.equal(typeof result, 'string');

    return result as string;
  };

  const message = (target: string) => messageFrom(todos, target);

  test('asks for a target when it is given nothing', () => {
    assert.match(message('  '), /No objective was named/);
  });

  test('resolves a number to the item at that position', () => {
    assert.equal(findTodo(todos, '2'), todos[1]);
  });

  test('resolves a padded number', () => {
    assert.equal(findTodo(todos, '002'), todos[1]);
  });

  test('refuses a number below the list', () => {
    assert.match(message('0'), /no objective number 0 - the list has 4/);
  });

  test('refuses a number past the end', () => {
    assert.match(message('9'), /no objective number 9 - the list has 4/);
  });

  test('prefers an exact match over a longer one containing it', () => {
    assert.equal(findTodo(todos, 'add tests'), todos[1]);
  });

  test('falls back to a substring match, ignoring case', () => {
    assert.equal(findTodo(todos, 'ROADMAP parser'), todos[2]);
  });

  test('says so when nothing matches, quoting what it was asked for', () => {
    assert.match(message('Buy MILK'), /No objective matches "Buy MILK"/);
  });

  test('refuses to guess between several matches and lists them', () => {
    const text = message('tests');

    assert.match(text, /2 objectives match "tests"/);
    assert.match(text, /^ {2}2\. Add tests$/m);
    assert.match(text, /^ {2}3\. Add tests for the roadmap parser$/m);
  });

  test('refuses to guess between duplicate wordings', () => {
    const duplicated = [todo('Add tests'), todo('Add tests')];

    assert.match(messageFrom(duplicated, 'Add tests'), /2 objectives match/);
  });
});

describe('readRoadmap', () => {
  test('hands back an empty roadmap when there is no file', () => {
    // an absent roadmap is the ordinary first run, not a failure
    assert.deepEqual(readRoadmap(), {
      title: '# Roadmap',
      preamble: '',
      todos: [],
      notes: '',
      extra: '',
      eol: '\n'
    });
  });

  test('parses the file when there is one', () => {
    writeFileSync(roadmapPath, fixture);

    assert.deepEqual(readRoadmap(), parseRoadmap(fixture));
  });
});

describe('writeRoadmap', () => {
  test('creates the file and reads back what it wrote', () => {
    const roadmap = parseRoadmap(fixture);

    writeRoadmap(roadmap);

    assert.ok(existsSync(roadmapPath));
    assert.deepEqual(readRoadmap(), roadmap);
  });

  test('keeps crlf endings so a checkout does not diff every line', () => {
    writeFileSync(
      roadmapPath,
      '# Roadmap\r\n\r\n## Todo\r\n\r\n- [ ] First\r\n'
    );

    writeRoadmap(readRoadmap());

    assert.doesNotMatch(read(), /[^\r]\n/);
  });
});

describe('currentContent', () => {
  test('is empty when there is no file', () => {
    assert.equal(currentContent(), '');
  });

  test('is the file verbatim when there is one', () => {
    writeFileSync(roadmapPath, fixture);

    assert.equal(currentContent(), fixture);
  });
});

describe('describeRoadmap', () => {
  const fileWith = (todos: string, notes = '') =>
    writeFileSync(
      roadmapPath,
      `# Roadmap\n\n## Todo\n\n${todos}\n\n## Notes\n\n${notes}\n`
    );

  test('says nothing when there is no file', () => {
    assert.equal(describeRoadmap(), undefined);
  });

  test('says nothing when there are no todos and no notes', () => {
    // the tool descriptions already tell the model the file is there to write
    fileWith('');

    assert.equal(describeRoadmap(), undefined);
  });

  test('describes a roadmap that only has todos', () => {
    fileWith('- [ ] First');

    const text = describeRoadmap() ?? '';

    assert.match(text, /## Project roadmap/);
    assert.match(text, new RegExp(roadmapName));
    assert.match(text, /### Todo/);
    assert.match(text, /1\. \[ \] First/);
    assert.doesNotMatch(text, /### Notes/);
  });

  test('describes a roadmap that only has notes', () => {
    fileWith('', 'Builds use rollup.');

    const text = describeRoadmap() ?? '';

    assert.match(text, /### Notes/);
    assert.match(text, /Builds use rollup\./);
    assert.match(text, /\(the todo list is empty\)/);
  });

  test('caps the completed items it reproduces', () => {
    fileWith(
      Array.from({ length: 25 }, (_, index) => `- [x] Item ${index + 1}`).join(
        '\n'
      )
    );

    assert.match(
      describeRoadmap() ?? '',
      /\(5 older completed objective\(s\) omitted/
    );
  });

  test('truncates a roadmap that outgrows the prompt budget', () => {
    // this block is resent on every single turn, so the cap is the point of it
    fileWith('- [ ] First', 'x'.repeat(notesBudget + 1));

    assert.match(describeRoadmap() ?? '', /truncated: showing/);
  });

  test('leaves a roadmap that fits alone', () => {
    fileWith('- [ ] First', 'Remember this.');

    assert.doesNotMatch(describeRoadmap() ?? '', /truncated/);
  });
});
