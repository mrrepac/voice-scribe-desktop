import type { AppUpdater } from 'electron-updater';
import type { UpdateState } from '../shared/updates';

type Updater = Pick<AppUpdater, 'on' | 'autoDownload' | 'autoInstallOnAppQuit' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall'>;

/**
 * Installation is always explicit and is guarded again in the main process.
 * `openDownload` switches to manual updates (unsigned macOS builds cannot replace
 * themselves): a new version is announced, and "download" opens its page instead.
 */
export class UpdateService {
  state: UpdateState;
  constructor(private updater: Updater, supported: boolean, private busy: () => boolean, private publish: (state: UpdateState) => void, private openDownload?: (version: string) => void) {
    this.state = !supported ? { phase: 'unsupported', message: 'Автообновление работает только в установленной версии.' }
      : openDownload ? { phase: 'idle', message: 'Новые версии проверяются автоматически.' }
      : { phase: 'idle', message: 'Обновляется автоматически.' };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    if (!supported) return;
    updater.on('checking-for-update', () => this.set({ phase: 'checking', message: 'Проверяем обновления…' }));
    updater.on('update-available', info => this.set({ phase: 'available', version: info.version, message: openDownload ? `Доступна версия ${info.version}. Скачайте её и установите поверх текущей.` : `Доступна версия ${info.version}.` }));
    updater.on('update-not-available', () => this.set({ phase: 'current', message: 'У вас последняя версия.' }));
    updater.on('download-progress', progress => this.set({ phase: 'downloading', version: this.state.version, percent: Math.round(progress.percent), message: `Загружаем обновление · ${Math.round(progress.percent)}%` }));
    updater.on('update-downloaded', info => this.set({ phase: 'ready', version: info.version, message: `Версия ${info.version} готова. Перезапустите приложение, когда закончите работу.` }));
    updater.on('error', () => this.error());
  }

  private set(state: UpdateState): void { this.state = state; this.publish(state); }
  private error(): void { this.set({ phase: 'error', message: 'Не удалось получить обновление. Проверьте интернет и попробуйте ещё раз.' }); }

  async check(background = false): Promise<UpdateState> {
    if (['unsupported', 'checking', 'downloading', 'ready'].includes(this.state.phase) || (background && this.busy())) return this.state;
    this.set({ phase: 'checking', message: 'Проверяем обновления…' });
    try {
      await this.updater.checkForUpdates();
      if (background && this.state.phase === 'available' && !this.openDownload) await this.download();
    } catch { this.error(); }
    return this.state;
  }

  async download(): Promise<UpdateState> {
    if (this.state.phase !== 'available') return this.state;
    if (this.openDownload) { this.openDownload(this.state.version ?? ''); return this.state; }
    this.set({ ...this.state, phase: 'downloading', percent: 0, message: 'Загружаем обновление…' });
    try { await this.updater.downloadUpdate(); } catch { this.error(); }
    return this.state;
  }

  install(): void {
    if (this.busy()) throw new Error('Сначала завершите запись или обработку аудио.');
    if (this.state.phase !== 'ready') throw new Error('Обновление ещё не загружено.');
    this.updater.quitAndInstall(true, true);
  }
}
