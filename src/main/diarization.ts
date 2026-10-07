import { fork, type ChildProcess } from 'node:child_process';
import type { SpeakerTurn, SpeakerProgress } from '../shared/speakers';

/** Native inference lives in a killable process, keeping Electron responsive. */
export class DiarizationService {
  private child: ChildProcess | null = null;
  private reject: ((error: Error) => void) | null = null;
  constructor(private script: string, private modelDirectory: string) {}

  run(pcm: Float32Array, progress: (value: SpeakerProgress) => void): Promise<SpeakerTurn[]> {
    if (this.child) return Promise.reject(new Error('Определение ораторов уже выполняется'));
    if (!(pcm instanceof Float32Array) || !pcm.length || pcm.length > 16000 * 60 * 120 || pcm.some(x => !Number.isFinite(x))) {
      return Promise.reject(new Error('Для определения ораторов нужен аудиофайл длительностью до двух часов'));
    }
    return new Promise((resolve, reject) => {
      const child = fork(this.script, [], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        serialization: 'advanced', windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      this.child = child;
      const finish = (error?: Error, turns?: SpeakerTurn[]) => {
        if (this.child !== child) return;
        this.child = null;
        this.reject = null;
        child.kill();
        if (error) reject(error); else resolve(turns ?? []);
      };
      this.reject = error => finish(error);
      // Drain diagnostics without retaining audio/model data or unbounded logs.
      child.stderr?.on('data', () => {});
      child.on('error', error => finish(error));
      child.on('exit', () => finish(new Error('Процесс определения ораторов завершился. Повторите попытку.')));
      child.on('message', (message: any) => {
        if (this.child !== child) return;
        if (message?.type === 'progress' && typeof message.message === 'string') progress({ message: message.message });
        else if (message?.type === 'result' && Array.isArray(message.turns)) finish(undefined, message.turns);
        else if (message?.type === 'error') finish(new Error(String(message.message)));
      });
      child.send({ pcm, modelDirectory: this.modelDirectory }, error => { if (error) finish(error); });
    });
  }

  cancel(): void { this.reject?.(new Error('Определение ораторов отменено')); }
}
