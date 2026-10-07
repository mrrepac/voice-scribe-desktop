import test from 'node:test';
import assert from 'node:assert/strict';
import { inferCorrection, upsertReplacement } from '../src/shared/corrections';
import { applyReplacements, parseReplacements } from '../src/shared/clean';

test('a reviewed Cyrillic phrase becomes a working dictionary rule', () => {
  const result = upsertReplacement('', '  войс скрайб  ', ' Voice Scribe ');
  assert.deepEqual(result, {from:'войс скрайб',to:'Voice Scribe',replacements:'войс скрайб = Voice Scribe',updated:false});
  assert.equal(applyReplacements('Открыть войс   скрайб.', parseReplacements(result.replacements)), 'Открыть Voice Scribe.');
});

test('upsert updates and deduplicates equivalent sources across all supported separators', () => {
  const raw = '# Личный словарь\r\nВойс   Скрайб -> Старое\r\nимя → Имя\r\n войс\tскрайб=Другое\r\nВОЙС СКРАЙБ → Третье\r\nнезаконченная строка\r\n';
  const result = upsertReplacement(raw, 'войс скрайб', 'Voice Scribe');
  assert.equal(result.updated, true);
  assert.equal(result.replacements, '# Личный словарь\r\nвойс скрайб = Voice Scribe\r\nимя → Имя\r\nнезаконченная строка\r\n');
  assert.equal(applyReplacements('Войс скрайб и имя.', parseReplacements(result.replacements)), 'Voice Scribe и Имя.');
});

test('comments, blank lines and invalid rules survive appending without reformatting', () => {
  const raw = '# войс скрайб = Комментарий\r\n\r\n  неполное правило  \r\n = пустой источник\r\nстарое = Старое';
  const result = upsertReplacement(raw, 'новое', 'Новое');
  assert.equal(result.replacements, `${raw}\r\nновое = Новое`);
  assert.equal(result.updated, false);
  assert.equal(upsertReplacement('a = A\n', 'b', 'B').replacements, 'a = A\nb = B');
});

test('lone carriage-return dictionaries remain usable after adding or updating a rule', () => {
  const result = upsertReplacement('# Словарь\ra = A\rb = старое', 'b', 'B');
  assert.equal(result.replacements, '# Словарь\ra = A\rb = B');
  const appended = upsertReplacement(result.replacements, 'c', 'C');
  assert.equal(appended.replacements, '# Словарь\ra = A\rb = B\rc = C');
  assert.equal(applyReplacements('a b c', parseReplacements(appended.replacements)), 'A B C');
});

test('arrow parsing distinguishes the source from a target containing separators', () => {
  const result = upsertReplacement('вай-фай -> Wi-Fi = сеть\nимя → Значение', 'вай-фай', 'Wi-Fi');
  assert.equal(result.replacements, 'вай-фай = Wi-Fi\nимя → Значение');
  assert.equal(applyReplacements('вай-фай', parseReplacements(result.replacements)), 'Wi-Fi');
});

test('case-only corrections remain valid and apply to acronyms', () => {
  const result = upsertReplacement('api = интерфейс', 'api', 'API');
  assert.equal(result.updated, true);
  assert.equal(applyReplacements('наш api готов', parseReplacements(result.replacements)), 'наш API готов');
  assert.deepEqual(inferCorrection('Наш api готов.', 'Наш API готов.'), {from:'api',to:'API'});
});

test('explicit case corrections apply literally while legacy lowercase-source rules retain sentence case', () => {
  for (const [from, to] of [['Scribe', 'scribe'], ['IPHONE', 'iPhone']]) {
    const result = upsertReplacement('', from, to);
    assert.equal(applyReplacements(`Наш ${from}.`, parseReplacements(result.replacements)), `Наш ${to}.`);
  }
  assert.equal(applyReplacements('Обсидиан открыт.', parseReplacements('обсидиан = obsidian')), 'Obsidian открыт.');
  assert.equal(applyReplacements('Scribe и IPHONE.', parseReplacements('Scribe = scribe\nIPHONE = iPhone')), 'scribe и iPhone.');
});

test('invalid or unrepresentable phrases are rejected rather than silently altered', () => {
  for (const [from, to] of [
    ['', 'слово'], ['слово', ' '], ['слово', 'слово'], [' слово ', 'слово'],
    ['две\nстроки', 'слово'], ['слово', 'две\rстроки'], ['слово\n', 'текст'],
    ['первая\u2028вторая', 'строка'], ['# комментарий', 'текст'],
    ['a=b', 'текст'], ['a→b', 'текст'], ['a->b', 'текст'],
    ['x'.repeat(201), 'текст'], ['слово', 'x'.repeat(201)],
  ]) assert.throws(() => upsertReplacement('', from, to), /INVALID_CORRECTION/);
  assert.equal(upsertReplacement('', 'слово', 'a = b → c -> d').to, 'a = b → c -> d');
});

test('capacity is checked on the complete dictionary without truncating preserved content', () => {
  const rule = 'a = b';
  const prefix = '#' + 'x'.repeat(50_000 - rule.length - 2) + '\n';
  assert.equal(upsertReplacement(prefix, 'a', 'b').replacements.length, 50_000);
  assert.throws(() => upsertReplacement(prefix + 'x', 'a', 'b'), /REPLACEMENTS_TOO_LONG/);
  const raw = '# ' + 'x'.repeat(49_990) + '\na = b';
  assert.throws(() => upsertReplacement(raw, 'a', 'longer replacement'), /REPLACEMENTS_TOO_LONG/);
});

test('inline changes expand to whole Cyrillic words and reproduce the reviewed edit', () => {
  for (const [before, after, from, to] of [
    ['Этот профект готов.', 'Этот проект готов.', 'профект', 'проект'],
    ['Я сказал приветт.', 'Я сказал привет.', 'приветт', 'привет'],
    ['Это прект.', 'Это проект.', 'прект', 'проект'],
    ['Нужен контест.', 'Нужен контекст.', 'контест', 'контекст'],
    ['Кот рядом.', 'Код рядом.', 'Кот', 'Код'],
  ]) {
    const correction = inferCorrection(before, after);
    assert.deepEqual(correction, {from,to});
    assert.equal(applyReplacements(before, parseReplacements(upsertReplacement('', from, to).replacements)), after);
  }
});

test('multiword names retain their complete changed phrase and surrounding punctuation', () => {
  const before = 'Открой «войс скрайб», пожалуйста.';
  const after = 'Открой «Voice Scribe», пожалуйста.';
  assert.deepEqual(inferCorrection(before, after), {from:'войс скрайб',to:'Voice Scribe'});
  assert.equal(applyReplacements(before, parseReplacements('войс скрайб = Voice Scribe')), after);
  assert.deepEqual(inferCorrection('Open Voice Scribe.', 'Open VoiceScribe.'), {from:'Voice Scribe',to:'VoiceScribe'});
});

test('Unicode word boundaries keep astral letters and combining accents intact', () => {
  assert.deepEqual(inferCorrection('До 𐐀𐐁𐐂 после.', 'До 𐐀𐐃𐐂 после.'), {from:'𐐀𐐁𐐂',to:'𐐀𐐃𐐂'});
  assert.deepEqual(inferCorrection('Пишем cafe\u0301.', 'Пишем café.'), {from:'cafe\u0301',to:'café'});
});

test('inference declines blank, deleted words, inserted words and punctuation-only edits', () => {
  for (const [before, after] of [
    ['', 'текст'], ['текст', ''], ['без изменений', 'без изменений'],
    ['Это лишнее слово.', 'Это слово.'], ['Это слово.', 'Это новое слово.'],
    ['Лишнее слово', 'слово'], ['это слово', 'это'],
    ['Привет!', 'Привет?'], ['Привет мир', 'Привет, мир'],
    ['Два  пробела.', 'Два пробела.'], ['До. Старое.', 'После. Новое.'],
    ['одна\nошибка', 'две\nправки'], ['До foo\nпосле', 'До bar после'],
    ['x'.repeat(201), 'y'.repeat(201)],
  ]) assert.equal(inferCorrection(before, after), null, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
});

test('a localized edit inside a multiline document still suggests only its changed word', () => {
  assert.deepEqual(inferCorrection('Первая строка\nНаш профект готов.\nПоследняя строка', 'Первая строка\nНаш проект готов.\nПоследняя строка'), {from:'профект',to:'проект'});
});
