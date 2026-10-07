// Ported unchanged from Voice Scribe 0.4.1 by mrrepac (MIT).
/*
 * Защита от галлюцинаций Whisper. Проверено: на тишине и на тихом фоновом шуме
 * модель уверенно выдаёт «[музыка]», на длинных паузах — «Продолжение следует…»
 * и титры несуществующих субтитровщиков. Лечим с двух сторон:
 *   1) не скармливаем модели тишину (trimSilence);
 *   2) вычищаем типовые артефакты из результата (cleanTranscript).
 * Модуль намеренно без зависимостей от Obsidian — чтобы его можно было тестировать.
 *
 * Regexp'ы здесь обходятся без lookbehind: на iOS до 16.4 его нет, и движок
 * падает уже при разборе литерала — вместе со всем плагином.
 */

const SR = 16000;
const FRAME = 320; // 20 мс
/** Запас по краям при обрезке — чтобы не срезать начало слова. */
const PAD_FRAMES = 15; // ~300 мс
/** Ниже этого пикового кадра (≈ −46 dBFS) в записи заведомо нет речи. */
const SILENT_PEAK = 0.005;
const ABS_FLOOR = 0.004;
const REL_FLOOR = 0.06;
/**
 * Минимум ОЗВУЧЕННОГО материала (сумма громких кадров, а не ширина окна —
 * окно всегда раздуто полями). Ниже этого — щелчок, кашель, стук, но не речь.
 */
const MIN_VOICED_SEC = 0.15;

/**
 * Обрезает тишину по краям записи (внутренние паузы не трогает).
 * Возвращает null, если речи нет вовсе — тогда модель можно вообще не грузить.
 */
export function trimSilence(audio: Float32Array): Float32Array | null {
  const n = Math.floor(audio.length / FRAME);
  if (n === 0) return null;

  const rms = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const start = i * FRAME;
    for (let j = start; j < start + FRAME; j++) sum += audio[j] * audio[j];
    rms[i] = Math.sqrt(sum / FRAME);
    if (rms[i] > peak) peak = rms[i];
  }
  if (peak < SILENT_PEAK) return null;

  const thr = Math.max(ABS_FLOOR, peak * REL_FLOOR);
  let first = -1;
  let last = -1;
  let voiced = 0;
  for (let i = 0; i < n; i++) {
    if (rms[i] > thr) {
      if (first < 0) first = i;
      last = i;
      voiced++;
    }
  }
  if (first < 0 || voiced * FRAME < MIN_VOICED_SEC * SR) return null;

  const from = Math.max(0, first - PAD_FRAMES) * FRAME;
  const to = Math.min(n, last + 1 + PAD_FRAMES) * FRAME;
  return audio.subarray(from, to);
}

/** Пометки нечеловеческих звуков: [музыка], (applause), ♪ … */
const NOISE_TAG =
  /[[(]\s*(музыка|музыка играет|играет музыка|смех|аплодисменты|звук|шум|пение|тишина|music|laughter|applause|singing|silence|sound|noise|blank_audio)\s*[\])]/giu;

/** Фразы-галлюцинации целиком (сравнение точное — чтобы не съесть живой текст). */
const EXACT = [
  "продолжение следует",
  "спасибо за просмотр",
  "спасибо за внимание",
  "подписывайтесь на канал",
  "thanks for watching",
  "thank you for watching",
  "please subscribe",
];

/** Титры субтитровщиков: сравниваем по началу — хвост там всегда разный. */
const PREFIX = ["субтитры сделал", "субтитры создавал", "субтитры делал", "редактор субтитров", "subtitles by"];

/**
 * Делит текст на предложения по пробелу ПОСЛЕ конечного знака; знак остаётся
 * при своём предложении. Замена для split(/(?<=[.!?…])\s+/) — см. шапку файла.
 */
function splitSentences(text: string): string[] {
  const re = /[.!?…]\s+/g;
  const out: string[] = [];
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(text.slice(start, m.index + 1));
    start = re.lastIndex;
  }
  out.push(text.slice(start));
  return out;
}

/** Нормализация для сравнения: регистр, пунктуация и пробелы не важны. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[!.,…?:;"«»()\-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Убирает звуковые пометки и предложения-галлюцинации.
 * Пустая строка на выходе = распознавать было нечего.
 */
export function cleanTranscript(raw: string): string {
  const text = raw.replace(NOISE_TAG, " ").replace(/[♪♫]/g, " ");
  const kept = splitSentences(text).filter((s) => {
    const n = norm(s);
    if (!n) return false;
    if (EXACT.includes(n)) return false;
    return !PREFIX.some((p) => n.startsWith(p));
  });
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
}

/*
 * Голосовая пунктуация (включается в настройках): отдельно стоящие
 * слова-команды («запятая», "comma"…) превращаются в знаки. Whisper обычно сам
 * дорисовывает знаки вокруг команды («Привет, запятая, как дела.») — поэтому
 * шаблон съедает и соседние знаки с пробелами. Словоформы не трогаем
 * («запятые», «точками» — живой текст). \b не работает с кириллицей (в JS \w —
 * только латиница), поэтому левая граница слова — захват предыдущего символа
 * (lookbehind нельзя, см. шапку файла), правая — \p{L}-lookahead.
 */
const cmd = (words: string, sub: string) => ({
  re: new RegExp(`(^|[^\\p{L}\\p{N}])[\\s,.!?…:;]*(?:${words})(?![\\p{L}\\p{N}])[.,!?…:;]*\\s*`, "giu"),
  sub,
});
/** Знаки и пробелы вокруг команды съедаются заменой; всё прочее возвращаем на место. */
const EATEN = /[\s,.!?…:;]/u;
/** Порядок важен: длинные фразы раньше своих подстрок («точка с запятой» до «точка»). */
const VOICE_CMDS = [
  cmd("вопросительный знак|question mark", "? "),
  cmd("восклицательный знак|exclamation mark|exclamation point", "! "),
  cmd("точка с запятой|semicolon", "; "),
  cmd("двоеточие|colon", ": "),
  cmd("многоточие|ellipsis", "… "),
  cmd("новый абзац|абзац|new paragraph", "\n\n"),
  cmd("с новой строки|новая строка|new line", "\n"),
  cmd("запятая|comma", ", "),
  cmd("тире|dash", " — "),
  cmd("точка|period|full stop", ". "),
];

/** Причёсывает пробелы/переносы после замен и поднимает регистр новых предложений. */
function tidyPunct(s: string): string {
  let out = s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim()
    .replace(/[\s,;:]+$/u, "");
  out = out.replace(/([.!?…]\s|\n+)(\p{Ll})/gu, (_, p: string, c: string) => p + c.toUpperCase());
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

/** Заменяет голосовые команды на знаки препинания. Вызывать ПОСЛЕ cleanTranscript. */
export function applyVoiceCommands(raw: string): string {
  let s = raw;
  for (const { re, sub } of VOICE_CMDS) {
    s = s.replace(re, (_m: string, pre: string) => (pre && !EATEN.test(pre) ? pre : "") + sub);
  }
  return tidyPunct(s);
}

/*
 * Пользовательский словарь замен. Whisper устойчиво коверкает то, чего не было в
 * его обучении: имена, названия, профессиональный жаргон — и коверкает ОДИНАКОВО
 * от записи к записи. Значит, это лечится один раз списком «слышится = пишется»,
 * а не ручной правкой каждой расшифровки.
 */

/**
 * Разобранный словарь: ОДНА регулярка на все правила. Именно одна, а не список:
 * применяя правила по очереди, мы прогоняли бы текст через них повторно, и
 * второе правило переписывало бы результат первого («обсидиан = Obsidian» плюс
 * «obsidian = Обсидиан» тихо отменяли бы друг друга). Один проход = каждый
 * кусок текста заменяется ровно один раз.
 */
export interface Replacements {
  re: RegExp;
  /** Чем менять — по номеру сработавшей группы в re. */
  to: string[];
  /** An uppercase source with a lowercase target explicitly corrects casing. */
  literalCase?: boolean[];
}

/** Строка словаря: до первого разделителя — что слышится, после — что писать. */
const RULE_RE = /^(.*?)\s*(?:=|→|->)\s*(.*)$/;
const RX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Разбор словаря из настроек. Пустые строки и начатые с # пропускаем, пустая
 * правая часть = слово выбрасывается (так вычищаются «э-э» и прочие паразиты).
 * Строки без разделителя молча игнорируем: человек мог не дописать правило.
 */
export function parseReplacements(raw: string): Replacements | null {
  const rules: { from: string; to: string }[] = [];
  for (const line of raw.split(/\r\n|\n|\r/u)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = RULE_RE.exec(s);
    if (!m) continue;
    const from = m[1].trim();
    if (from) rules.push({ from, to: m[2].trim() });
  }
  if (!rules.length) return null;
  // Длинное правило раньше короткого: при пересечении должно побеждать более
  // конкретное («рэп театр» раньше «рэп»), а альтернация берёт первое подошедшее.
  rules.sort((a, b) => b.from.length - a.from.length);
  // Пробелы внутри фразы — «сколько угодно»: Whisper ставит их по-своему.
  // Границы слова: слева захватываем предыдущий символ (lookbehind нельзя,
  // см. шапку файла), справа хватает lookahead. Иначе «мс» правилось бы
  // внутри «смс», а «рэп» — внутри «рэпер».
  const alt = rules.map((r) => `(${r.from.replace(RX_SPECIAL, "\\$&").replace(/\s+/g, "\\s+")})`).join("|");
  return {
    re: new RegExp(`(^|[^\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, "giu"),
    to: rules.map((r) => r.to),
    // A reviewed "Scribe = scribe" or "IPHONE = iPhone" rule must be able to
    // lower the original capital. Lowercase-source rules retain the historical
    // sentence-capitalization behavior ("обсидиан = obsidian" -> "Obsidian").
    literalCase: rules.map(({ from, to }) => {
      const sourceFirst = from.charAt(0);
      const targetFirst = to.charAt(0);
      return sourceFirst !== sourceFirst.toLowerCase() && targetFirst !== targetFirst.toUpperCase();
    }),
  };
}

/**
 * Регистр берём у распознанного слова: замена, написанная строчными, встав в
 * начало предложения, поднимет первую букву сама. Если же в правой части буква
 * уже заглавная — это осознанный выбор («спб = СПб»), и мы его не трогаем.
 */
function matchCase(hit: string, to: string): string {
  const h = hit.charAt(0);
  const t = to.charAt(0);
  const hitUpper = h !== h.toLowerCase();
  const toLower = t !== t.toUpperCase();
  return hitUpper && toLower ? t.toUpperCase() + to.slice(1) : to;
}

/** Применяет словарь. Вызывать последней: это окончательный вид текста. */
export function applyReplacements(text: string, set: Replacements | null): string {
  if (!set) return text;
  const s = text.replace(set.re, (_m: string, ...args: unknown[]) => {
    const pre = args[0] as string;
    // Дальше идут группы правил (по одной на правило), затем offset и строка;
    // сработавшая — единственная не-undefined, её номер и есть номер правила.
    const hits = args.slice(1, 1 + set.to.length) as (string | undefined)[];
    const i = hits.findIndex((h) => h !== undefined);
    const to = set.to[i];
    return pre + (to ? (set.literalCase?.[i] ? to : matchCase(hits[i] as string, to)) : "");
  });
  // После выброшенных слов остаются двойные пробелы и пробел перед знаком.
  // Переносы строк не трогаем: их мог поставить «новый абзац».
  return s
    .replace(/ {2,}/g, " ")
    .replace(/ +([,.!?…;:])/g, "$1")
    .trim();
}
