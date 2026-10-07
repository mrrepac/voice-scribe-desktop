/** An explicit dictionary rule reviewed by the user. */
export interface Correction { from: string; to: string }
export interface RememberedCorrection extends Correction { replacements: string; updated: boolean }

const MAX_PHRASE = 200;
const MAX_DICTIONARY = 50_000;
const LINE_BREAK = /[\r\n\u2028\u2029]/u;
// Same grammar as parseReplacements: the source ends at the first separator.
const RULE = /^(.*?)\s*(?:=|→|->)\s*(.*)$/;
const sourceKey = (value: string) => value.trim().replace(/\s+/gu, ' ').toLowerCase();

function validateCorrection(from: string, to: string): Correction {
  // Check line breaks before trim: an accidental pasted newline must not turn
  // into a different, silently accepted dictionary entry.
  if (typeof from !== 'string' || typeof to !== 'string' || LINE_BREAK.test(from) || LINE_BREAK.test(to)) {
    throw new Error('INVALID_CORRECTION');
  }
  from = from.trim();
  to = to.trim();
  if (!from || !to || from.length > MAX_PHRASE || to.length > MAX_PHRASE || from === to
    || from.startsWith('#') || /(?:=|→|->)/u.test(from)) {
    throw new Error('INVALID_CORRECTION');
  }
  return { from, to };
}

/**
 * Add or replace one rule without reformatting the rest of the user's dictionary.
 * All conflicting spellings of the same source are removed so the old rule
 * cannot win parseReplacements' first-match ordering.
 */
export function upsertReplacement(raw: string, from: string, to: string): RememberedCorrection {
  const correction = validateCorrection(from, to);
  const key = sourceKey(correction.from);
  const rule = `${correction.from} = ${correction.to}`;
  const parts = raw.split(/(\r\n|\n|\r)/u);
  let replacements = '';
  let updated = false;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const newline = parts[i + 1] ?? '';
    const trimmed = line.trim();
    const match = trimmed && !trimmed.startsWith('#') ? RULE.exec(trimmed) : null;
    if (match && sourceKey(match[1]) === key) {
      if (!updated) replacements += rule + newline;
      updated = true;
    } else {
      replacements += line + newline;
    }
  }
  if (!updated) {
    const newline = raw.match(/\r\n|\n|\r/u)?.[0] ?? '\n';
    replacements += (raw && !/[\r\n]$/u.test(raw) ? newline : '') + rule;
  }
  if (replacements.length > MAX_DICTIONARY) throw new Error('REPLACEMENTS_TOO_LONG');
  return { ...correction, replacements, updated };
}

const word = (character: string | undefined) => character !== undefined && /[\p{L}\p{N}\p{M}_]/u.test(character);
const insideWord = (text: string[], index: number) => word(text[index - 1]) && word(text[index]);

/**
 * Suggest one localized correction from an editor change. This never learns or
 * saves a rule: the caller must show the candidate for the user to review.
 */
export function inferCorrection(before: string, after: string): Correction | null {
  if (before === after || !before.trim() || !after.trim()) return null;
  // Code points keep astral letters intact while expanding Unicode words.
  const oldText = Array.from(before);
  const newText = Array.from(after);
  let start = 0;
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  // The shared context moves on both sides equally, preserving the exact old
  // and new phrases. This also handles inserting/removing letters in a word.
  while (start > 0 && (insideWord(oldText, start) || insideWord(newText, start))) start--;
  while (oldEnd < oldText.length && newEnd < newText.length
    && (insideWord(oldText, oldEnd) || insideWord(newText, newEnd))) {
    oldEnd++;
    newEnd++;
  }

  const from = oldText.slice(start, oldEnd).join('');
  const to = newText.slice(start, newEnd).join('');
  // Whole-word deletion/insertion, whitespace and punctuation-only edits do
  // not identify a reusable spoken phrase. Sentence rewrites are too broad.
  if (!/[\p{L}\p{N}]/u.test(from) || !/[\p{L}\p{N}]/u.test(to)
    || /[.!?…;]\s+\S/u.test(from) || /[.!?…;]\s+\S/u.test(to)) return null;
  try {
    return validateCorrection(from, to);
  } catch {
    return null;
  }
}
