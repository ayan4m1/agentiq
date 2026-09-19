import { getLogger } from '../modules/logging';
import {
  currentContent,
  notesBudget,
  readRoadmap,
  roadmapName,
  serializeRoadmap,
  writeRoadmap
} from '../modules/roadmap';
import { makeParameter, makeTool, renderDiff } from '../utils';

const log = getLogger('update_notes');

export const definition = makeTool(
  'update_notes',
  `Writes to the Notes section of ${roadmapName}, where this project keeps facts worth remembering between sessions - decisions, gotchas, where things live. Appends by default.`,
  [
    makeParameter(
      'string',
      'text',
      'The note to record. Keep it to facts that will still matter next month'
    ),
    makeParameter(
      'boolean',
      'replace',
      'Replace the whole Notes section instead of appending to it. Use this to condense notes that have grown long',
      false
    )
  ]
);

type Args = {
  text: string;
  replace?: boolean;
};

export const handler = async ({ text, replace }: Args) => {
  const body = text
    .trim()
    // a "## " line in the notes would be read back as the start of a new
    // section and cut the notes in half, so headings inside a note are demoted
    .replace(/^##(?!#)/gm, '###');

  // an empty note is a no-op, but an empty replacement is how the model clears
  // the section, so only the append case has nothing to do
  if (!body && !replace) {
    return 'update_notes needs some text. Call it again with the note written out, or set replace to true to clear the Notes section.';
  }

  const before = currentContent();
  const roadmap = readRoadmap();
  const notes =
    replace || !roadmap.notes ? body : `${roadmap.notes}\n\n${body}`;
  const updated = { ...roadmap, notes };

  renderDiff(roadmapName, before, serializeRoadmap(updated));
  writeRoadmap(updated);

  log.info(
    `${replace ? 'Replaced' : 'Appended to'} the notes in ${roadmapName}`
  );

  return [
    replace
      ? `Replaced the Notes section of ${roadmapName}; it is now ${notes.length} characters.`
      : `Appended ${body.length} characters to the Notes section of ${roadmapName}; it is now ${notes.length} characters.`,
    // truncation happens silently when the prompt is built next session, so
    // this is the one moment the model can still do something about it
    notes.length > notesBudget
      ? 'That is more than fits in the system prompt, so the oldest part will be cut off next session. Call update_notes with replace set to true and a condensed version.'
      : undefined
  ]
    .filter(Boolean)
    .join(' ');
};
