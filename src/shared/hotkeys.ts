export type Hotkey = 'ctrl-space' | 'ctrl-alt-space' | 'win-alt';

/** Proofreading is always the dictation shortcut plus Shift. */
export const HOTKEYS: Record<Hotkey, { name: string; label: string; proofread: string }> = {
  'ctrl-space': { name: 'Ctrl + Space', label: 'Ctrl + Space', proofread: 'Ctrl + Shift + Space' },
  'ctrl-alt-space': { name: 'Ctrl + Alt + Space', label: 'Ctrl + Alt + Space', proofread: 'Ctrl + Alt + Shift + Space' },
  'win-alt': { name: 'Левые Win + Alt', label: 'Win + Alt', proofread: 'Win + Alt + Shift' },
};

export const isHotkey = (value: unknown): value is Hotkey => typeof value === 'string' && Object.hasOwn(HOTKEYS, value);
