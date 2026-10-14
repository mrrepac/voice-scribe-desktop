export type Preset = 'ctrl-space' | 'ctrl-alt-space' | 'win-alt' | 'insert';
/** A preset, or `key:` + modifiers (ctrl, alt, shift, win in this order) + a Windows virtual-key code, e.g. `key:ctrl+alt+120`. */
export type Hotkey = Preset | `key:${string}`;

export const HOTKEYS: Record<Preset, { name: string; label: string }> = {
  'ctrl-space': { name: 'Ctrl + Space', label: 'Ctrl + Space' },
  'ctrl-alt-space': { name: 'Ctrl + Alt + Space', label: 'Ctrl + Alt + Space' },
  'win-alt': { name: 'Левые Win + Alt', label: 'Win + Alt' },
  insert: { name: 'Insert', label: 'Insert' },
};

/** A shortcut, or a key press reported by the native helper while it records a new one. */
export interface CustomHotkey { ctrl: boolean; alt: boolean; shift: boolean; win: boolean; key: number }
export type CapturedKey = CustomHotkey;

const isPreset = (value: unknown): value is Preset => typeof value === 'string' && Object.hasOwn(HOTKEYS, value);
const MODIFIER_KEYS = new Set([0x10, 0x11, 0x12, 0x5b, 0x5c, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]);
const V = 0x56, ESCAPE = 0x1b, SPACE = 0x20, INSERT = 0x2d;

const NAMES: Record<number, string> = {
  0x08: 'Backspace', 0x09: 'Tab', 0x0c: 'Clear', 0x0d: 'Enter', 0x13: 'Pause', 0x14: 'CapsLock', 0x20: 'Space',
  0x21: 'PageUp', 0x22: 'PageDown', 0x23: 'End', 0x24: 'Home', 0x25: '←', 0x26: '↑', 0x27: '→', 0x28: '↓',
  0x2c: 'PrintScreen', 0x2d: 'Insert', 0x2e: 'Delete', 0x5d: 'Menu', 0x5f: 'Sleep',
  0x6a: 'Num *', 0x6b: 'Num +', 0x6c: 'Num Enter', 0x6d: 'Num −', 0x6e: 'Num .', 0x6f: 'Num /', 0x90: 'NumLock', 0x91: 'ScrollLock',
  0xa6: 'Браузер: назад', 0xa7: 'Браузер: вперёд', 0xa8: 'Браузер: обновить', 0xa9: 'Браузер: стоп', 0xaa: 'Поиск', 0xab: 'Избранное', 0xac: 'Домашняя страница',
  0xad: 'Без звука', 0xae: 'Тише', 0xaf: 'Громче', 0xb0: 'Следующий трек', 0xb1: 'Предыдущий трек', 0xb2: 'Стоп', 0xb3: 'Пауза/воспроизведение',
  0xb4: 'Почта', 0xb5: 'Медиаплеер', 0xb6: 'Приложение 1', 0xb7: 'Приложение 2',
  0xba: ';', 0xbb: '=', 0xbc: ',', 0xbd: '-', 0xbe: '.', 0xbf: '/', 0xc0: '`', 0xdb: '[', 0xdc: '\\', 0xdd: ']', 0xde: "'", 0xe2: '\\ (102)',
};

export function keyName(key: number): string {
  if (NAMES[key]) return NAMES[key];
  if ((key >= 0x30 && key <= 0x39) || (key >= 0x41 && key <= 0x5a)) return String.fromCharCode(key);
  if (key >= 0x60 && key <= 0x69) return `Num ${key - 0x60}`;
  if (key >= 0x70 && key <= 0x87) return `F${key - 0x6f}`;
  return `Клавиша 0x${key.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Keys used for typing or navigation: alone or with Shift they would stop working in every application. */
function typingKey(key: number): boolean {
  return key === 0x08 || key === 0x09 || key === 0x0d || key === SPACE || (key >= 0x21 && key <= 0x28) || key === 0x2e
    || (key >= 0x30 && key <= 0x39) || (key >= 0x41 && key <= 0x5a) || (key >= 0x60 && key <= 0x6f)
    || (key >= 0xba && key <= 0xc0) || (key >= 0xdb && key <= 0xdf) || key === 0xe2;
}

/** Why a shortcut cannot be used, or null when it can. */
export function hotkeyProblem(value: CustomHotkey): string | null {
  const { key, ctrl, alt, shift, win } = value;
  if (!Number.isInteger(key) || key < 0x07 || key > 0xfe || key === 0xe8) return 'Эта клавиша не поддерживается.';
  if (MODIFIER_KEYS.has(key)) return 'Нажмите основную клавишу вместе с модификаторами.';
  if (key === ESCAPE) return 'Esc отменяет запись — выберите другую клавишу.';
  if (key === V && ctrl && alt && !shift && !win) return 'Ctrl + Alt + V вставляет последний результат — выберите другое сочетание.';
  if (!ctrl && !alt && !win && typingKey(key)) return `${keyName(key)} без Ctrl, Alt или Win мешала бы печатать. Добавьте модификатор или выберите F-клавишу, Pause, CapsLock и т. п.`;
  return null;
}

export function parseCustom(value: unknown): CustomHotkey | null {
  if (typeof value !== 'string') return null;
  const match = /^key:((?:ctrl\+)?(?:alt\+)?(?:shift\+)?(?:win\+)?)(\d{1,3})$/.exec(value);
  if (!match) return null;
  const mods = match[1];
  const custom = { ctrl: mods.includes('ctrl'), alt: mods.includes('alt'), shift: mods.includes('shift'), win: mods.includes('win'), key: Number(match[2]) };
  return hotkeyProblem(custom) === null ? custom : null;
}

export function customHotkey(value: CustomHotkey): Hotkey {
  // Shortcuts equal to a preset keep the preset's name.
  const { key, ctrl, alt, shift, win } = value;
  if (key === SPACE && ctrl && !shift && !win) return alt ? 'ctrl-alt-space' : 'ctrl-space';
  if (key === INSERT && !ctrl && !alt && !shift && !win) return 'insert';
  return `key:${ctrl ? 'ctrl+' : ''}${alt ? 'alt+' : ''}${shift ? 'shift+' : ''}${win ? 'win+' : ''}${key}`;
}

/** Turns a recorded key press into a shortcut. */
export function capturedHotkey(value: CapturedKey): { hotkey: Hotkey } | { error: string } {
  const problem = hotkeyProblem(value);
  return problem ? { error: problem } : { hotkey: customHotkey(value) };
}

export const isHotkey = (value: unknown): value is Hotkey => isPreset(value) || parseCustom(value) !== null;

export function hotkeyLabel(value: Hotkey): string {
  if (isPreset(value)) return HOTKEYS[value].label;
  const custom = parseCustom(value);
  if (!custom) return HOTKEYS['ctrl-space'].label;
  const mods = [custom.ctrl && 'Ctrl', custom.alt && 'Alt', custom.shift && 'Shift', custom.win && 'Win'].filter((part): part is string => Boolean(part));
  return [...mods, keyName(custom.key)].join(' + ');
}
