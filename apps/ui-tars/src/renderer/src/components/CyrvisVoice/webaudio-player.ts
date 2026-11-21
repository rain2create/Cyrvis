const SAMPLE_RATE = 24000;
// Wait for a small amount of audio before starting. This covers the gap
// between Qwen audio deltas without the audible start delay of the old 0.75s
// WAV segments.
const INITIAL_BUFFER_SECONDS = 0.35;
const START_LEAD_SECONDS = 0.08;

interface SinkableAudioContext extends AudioContext {
  setSinkId?: (id: string) => Promise<void>;
}

/**
 * Gapless PCM player backed by a single AudioContext.
 *
 * The old WavStreamPlayer created a new <audio> element for every 0.75s of
 * audio, which produced clicks and short gaps at segment boundaries. Scheduling
 * AudioBufferSourceNodes back-to-back on one context removes those boundaries.
 */
export class WebAudioStreamPlayer {
  private readonly onIdle: () => void;
  private readonly onError: (error: unknown) => void;
  private readonly onSegmentStart?: (
    pcm16: Int16Array,
    startedAt: number,
  ) => void;

  private context: SinkableAudioContext | null = null;
  private contextReady: Promise<SinkableAudioContext> | null = null;
  private gain: GainNode | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private nextStartTime = 0;
  private outputDeviceId: string | null = null;
  private finished = false;
  private paused = false;
  private idleEmitted = false;
  private started = false;

  constructor(
    onIdle: () => void,
    onError: (error: unknown) => void,
    onSegmentStart?: (pcm16: Int16Array, startedAt: number) => void,
  ) {
    this.onIdle = onIdle;
    this.onError = onError;
    this.onSegmentStart = onSegmentStart;
  }

  get isActive(): boolean {
    return this.pendingSamples > 0 || this.sources.size > 0 || this.started;
  }

  /** Approximate audio still waiting to reach the speaker. */
  get queuedMs(): number {
    const pendingMs = (this.pendingSamples / SAMPLE_RATE) * 1000;
    if (!this.context || this.nextStartTime === 0) {
      return pendingMs;
    }
    const scheduledMs = Math.max(
      0,
      (this.nextStartTime - this.context.currentTime) * 1000,
    );
    return Math.max(pendingMs, scheduledMs);
  }

  play(pcm16: Int16Array): void {
    if (this.finished || !pcm16.length) {
      return;
    }
    this.pending.push(pcm16.slice());
    this.pendingSamples += pcm16.length;
    this.started = true;

    const bufferedSeconds = this.pendingSamples / SAMPLE_RATE;
    if (bufferedSeconds >= INITIAL_BUFFER_SECONDS || this.nextStartTime > 0) {
      void this.pump().catch((error) => this.fail(error));
    }
  }

  finish(): void {
    this.finished = true;
    void this.pump().catch((error) => this.fail(error));
    this.maybeIdle();
  }

  pause(): void {
    if (this.paused) {
      return;
    }
    this.paused = true;
    void this.context?.suspend().catch(() => undefined);
  }

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    void this.context
      ?.resume()
      .then(() => this.pump())
      .catch(() => undefined);
  }

  stop(notifyIdle = true): void {
    const wasActive = this.isActive;
    this.finished = true;
    this.paused = false;
    if (!notifyIdle) {
      this.idleEmitted = true;
    }
    this.pending = [];
    this.pendingSamples = 0;
    this.nextStartTime = 0;
    this.started = false;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source.disconnect();
    }
    this.sources.clear();
    const context = this.context;
    this.context = null;
    this.contextReady = null;
    this.gain = null;
    if (context && context.state !== 'closed') {
      void context.close().catch(() => undefined);
    }
    if (wasActive && notifyIdle) {
      this.emitIdle();
    }
  }

  async setSinkId(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    const context = await this.ensureContext();
    if (!context.setSinkId || !deviceId || deviceId === 'default') {
      return;
    }
    await context.setSinkId(deviceId);
  }

  private fail(error: unknown): void {
    this.stop(false);
    this.onError(error);
  }

  private async ensureContext(): Promise<SinkableAudioContext> {
    if (this.contextReady) {
      const context = await this.contextReady;
      if (context.state === 'suspended' && !this.paused) await context.resume();
      return context;
    }
    this.contextReady = (async () => {
      const context = new AudioContext() as SinkableAudioContext;
      this.context = context;
      this.gain = context.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(context.destination);
      if (this.outputDeviceId && this.outputDeviceId !== 'default') {
        if (!context.setSinkId)
          throw new Error('当前播放器无法选择输出设备，请改用系统默认输出。');
        await context.setSinkId(this.outputDeviceId);
      }
      if (context.state === 'suspended' && !this.paused) await context.resume();
      if (context.state !== 'running' && !this.paused)
        throw new Error('音频设备没有启动，请点击重新播报。');
      return context;
    })();
    return this.contextReady;
  }

  private async pump(): Promise<void> {
    if (this.paused || (this.finished && this.pendingSamples === 0)) {
      this.maybeIdle();
      return;
    }
    if (this.pendingSamples === 0) {
      this.maybeIdle();
      return;
    }
    const context = await this.ensureContext();
    if (this.paused) {
      return;
    }

    // Schedule the queue in bounded 1s blocks. A single 50s AudioBuffer has
    // only one startedAt, so the main-process echo detector could not align
    // the current playback reference and relative voiceprint disabled itself.
    const pending = this.pending;
    const total = this.pendingSamples;
    this.pending = [];
    this.pendingSamples = 0;

    const now = context.currentTime;
    if (now > this.nextStartTime && this.nextStartTime > 0) {
      console.warn('[cyrvis] audio underrun', {
        gapMs: Math.round((now - this.nextStartTime) * 1000),
      });
    }
    let startAt = Math.max(now + START_LEAD_SECONDS, this.nextStartTime);
    let chunkIndex = 0;
    let chunkOffset = 0;
    let scheduled = 0;
    const maxBlockSamples = SAMPLE_RATE; // 1s

    while (scheduled < total) {
      const size = Math.min(maxBlockSamples, total - scheduled);
      const samples = new Int16Array(size);
      let filled = 0;
      while (filled < size) {
        const chunk = pending[chunkIndex];
        const take = Math.min(chunk.length - chunkOffset, size - filled);
        samples.set(chunk.subarray(chunkOffset, chunkOffset + take), filled);
        filled += take;
        chunkOffset += take;
        if (chunkOffset >= chunk.length) {
          chunkIndex += 1;
          chunkOffset = 0;
        }
      }

      const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i += 1) {
        channel[i] = samples[i] / 0x8000;
      }

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain!);
      const startedAt = Date.now() + (startAt - context.currentTime) * 1000;

      this.sources.add(source);
      source.onended = () => {
        this.sources.delete(source);
        source.disconnect();
        if (
          this.finished &&
          this.pendingSamples === 0 &&
          this.sources.size === 0
        ) {
          this.maybeIdle();
        }
      };

      try {
        source.start(startAt);
        this.onSegmentStart?.(samples, startedAt);
      } catch (error) {
        this.sources.delete(source);
        this.onError(error);
        break;
      }

      this.nextStartTime = startAt + buffer.duration;
      startAt = this.nextStartTime;
      scheduled += size;
    }

    // If more deltas arrived while awaiting the context/buffer allocation,
    // schedule them immediately after this block.
    if (this.pendingSamples > 0) {
      void this.pump().catch((error) => this.fail(error));
    }
  }

  private maybeIdle(): void {
    if (!this.finished || this.pendingSamples > 0 || this.sources.size > 0) {
      return;
    }
    if (this.nextStartTime > 0 && this.context) {
      const remaining = this.nextStartTime - this.context.currentTime;
      if (remaining > 0.01) {
        return;
      }
    }
    this.emitIdle();
  }

  private emitIdle(): void {
    if (this.idleEmitted) {
      return;
    }
    this.idleEmitted = true;
    this.onIdle();
  }
}
