interface RecoverableBridge { on(event: string, handler: () => void): unknown; start(executable:string): void; stop(): void; }
export interface NativeHealth { ready: boolean; retrying: boolean; message: string; }
export class NativeRecovery {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stable: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private attempts = 0;
  state: NativeHealth = {ready:false,retrying:false,message:'Подключаем горячие клавиши…'};
  constructor(private bridge: RecoverableBridge, private executable: string, private publish: (state: NativeHealth)=>void, private delays=[1000,3000,8000], private stableMs=30000) {
    bridge.on('failure',()=>this.failed());
    bridge.on('ready',()=>{
      if(this.stopped)return;
      this.set({ready:true,retrying:false,message:'Горячие клавиши подключены'});
      clearTimeout(this.stable);
      this.stable=setTimeout(()=>{this.attempts=0;},this.stableMs);
    });
  }
  restart(): void {
    this.stop();this.stopped=false;this.attempts=0;
    this.set({ready:false,retrying:true,message:'Подключаем горячие клавиши…'});
    this.bridge.start(this.executable);
  }
  stop(): void { this.stopped=true;clearTimeout(this.timer);clearTimeout(this.stable);this.bridge.stop(); }
  private failed(): void {
    if(this.stopped)return;
    clearTimeout(this.stable);clearTimeout(this.timer);
    if(this.attempts>=this.delays.length){this.set({ready:false,retrying:false,message:'Горячие клавиши недоступны. Нажмите «Подключить заново».'});return;}
    const delay=this.delays[this.attempts++];
    this.set({ready:false,retrying:true,message:`Восстанавливаем горячие клавиши · попытка ${this.attempts} из ${this.delays.length}`});
    this.timer=setTimeout(()=>{if(!this.stopped)this.bridge.start(this.executable);},delay);
  }
  private set(state:NativeHealth):void {this.state=state;this.publish(state);}
}
