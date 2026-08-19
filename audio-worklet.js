// LinkLine low-latency audio core.
// Browser audio still runs at 48 kHz. Transport is downsampled to 24 kHz
// to cut raw microphone bandwidth roughly in half.

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 480; // 20 ms at 24 kHz
    this.pending = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.muted = false;
    this.pairSum = 0;
    this.pairCount = 0;

    this.port.onmessage = (event) => {
      if (event.data?.type === 'mute') {
        this.muted = Boolean(event.data.value);
        if (this.muted) {
          this.offset = 0;
          this.pairSum = 0;
          this.pairCount = 0;
        }
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    // The capture node is intentionally silent in the local speakers.
    if (output) output.fill(0);
    if (!input || this.muted) return true;

    // AudioContext is requested at 48 kHz. Average each pair of samples
    // to produce a simple, voice-friendly 24 kHz stream.
    for (let i = 0; i < input.length; i++) {
      this.pairSum += Math.max(-1, Math.min(1, input[i]));
      this.pairCount += 1;

      if (this.pairCount === 2) {
        const value = this.pairSum * 0.5;
        this.pending[this.offset++] =
          value < 0 ? value * 32768 : value * 32767;

        this.pairSum = 0;
        this.pairCount = 0;

        if (this.offset === this.chunkSize) {
          const chunk = this.pending;
          this.port.postMessage(chunk.buffer, [chunk.buffer]);
          this.pending = new Int16Array(this.chunkSize);
          this.offset = 0;
        }
      }
    }

    return true;
  }
}

class StreamPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.queue = [];
    this.current = null;
    this.offset = 0;
    this.started = false;

    // 2 chunks = about 40 ms of jitter protection.
    this.targetChunks = 2;

    // Never play a huge backlog of old speech.
    this.maxChunks = 4;

    // Transport is 24 kHz while output is 48 kHz.
    this.sampleValue = 0;
    this.repeatLeft = 0;

    this.port.onmessage = (event) => {
      if (event.data?.type === 'clear') {
        this.reset();
        return;
      }

      if (!(event.data instanceof ArrayBuffer)) return;

      this.queue.push(new Int16Array(event.data));

      // If packets arrive in a burst, jump forward to the newest audio
      // instead of becoming seconds behind the video.
      if (this.queue.length > this.maxChunks) {
        this.queue = this.queue.slice(-this.targetChunks);
        this.current = null;
        this.offset = 0;
        this.repeatLeft = 0;
        this.started = true;
      }

      if (!this.started && this.queue.length >= this.targetChunks) {
        this.started = true;
      }
    };
  }

  reset() {
    this.queue = [];
    this.current = null;
    this.offset = 0;
    this.started = false;
    this.sampleValue = 0;
    this.repeatLeft = 0;
  }

  nextTransportSample() {
    while (!this.current || this.offset >= this.current.length) {
      this.current = this.queue.shift() || null;
      this.offset = 0;

      if (!this.current) {
        this.started = false;
        return null;
      }
    }

    return this.current[this.offset++] / 32768;
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;

    output.fill(0);
    if (!this.started) return true;

    for (let i = 0; i < output.length; i++) {
      // Hold each 24 kHz transport sample for two 48 kHz output samples.
      if (this.repeatLeft === 0) {
        const sample = this.nextTransportSample();
        if (sample === null) break;
        this.sampleValue = sample;
        this.repeatLeft = 2;
      }

      output[i] = this.sampleValue;
      this.repeatLeft -= 1;
    }

    return true;
  }
}

registerProcessor('mic-capture', MicCaptureProcessor);
registerProcessor('stream-player', StreamPlayerProcessor);
