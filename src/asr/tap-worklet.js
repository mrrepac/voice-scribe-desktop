// Adapted from Voice Scribe 0.4.1 by mrrepac (MIT).
// One packet per 160 ms; a flush preserves the last partial packet on stop.
const PACK = 2560;
class VoiceScribeTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(PACK);
    this.length = 0;
    this.flushed = false;
    this.port.onmessage = ({ data }) => {
      if (data !== "flush") return;
      this.flushed = true;
      if (this.length) {
        const tail = this.buffer.slice(0, this.length);
        this.port.postMessage(tail, [tail.buffer]);
        this.length = 0;
      }
      this.port.postMessage({ flushed: true });
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (this.flushed || !channels?.length || !channels[0]?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i] / channels.length;
      this.buffer[this.length++] = mono;
      if (this.length === PACK) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(PACK);
        this.length = 0;
      }
    }
    return true;
  }
}
registerProcessor("voice-scribe-tap", VoiceScribeTap);
