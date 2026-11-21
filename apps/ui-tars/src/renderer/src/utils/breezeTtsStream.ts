/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { BREEZE_TTS_DEFAULT_SEED } from '../../../shared/breezeTts';

export const BREEZE_TTS_STREAM_FIRST_MIN_CHARS = 4;
export const BREEZE_TTS_STREAM_FIRST_MAX_CHARS = 18;
export const BREEZE_TTS_STREAM_MIN_CHARS = 24;
export const BREEZE_TTS_STREAM_MAX_CHARS = 48;
export const BREEZE_TTS_FIRST_AUDIO_BUFFER_MS = 100;

export const getAudioStartDelaySeconds = (firstAudioReported: boolean) =>
  firstAudioReported ? 0.02 : BREEZE_TTS_FIRST_AUDIO_BUFFER_MS / 1000;

/**
 * Route a WebAudio context to a specific output device. Older Electron/OS
 * builds may not expose setSinkId; in that case playback keeps following the
 * system default instead of failing.
 */
export const applyAudioSink = async (
  audioContext: AudioContext,
  deviceId: string,
): Promise<void> => {
  const sinkable = audioContext as AudioContext & {
    setSinkId?: (id: string) => Promise<void>;
  };
  if (!sinkable.setSinkId || !deviceId) {
    return;
  }
  try {
    await sinkable.setSinkId(deviceId === 'default' ? '' : deviceId);
  } catch (error) {
    console.warn('[cyrvis] audio output device unavailable', error);
  }
};

export type BreezeStreamConfig = {
  wsUrl: string;
  instruction?: string;
  voiceId?: string;
  cfgScale?: number;
  seed?: number;
  minimumChars?: number;
  maximumChars?: number;
  firstMinimumChars?: number;
  firstMaximumChars?: number;
  splitChars?: number;
  onSpeaking?: (text: string) => void;
  onFirstAudio?: () => void;
};

type BreezeControlMessage = {
  type: string;
  text?: string;
  message?: string;
  sample_rate?: number;
};

export const pcm16ToFloat32 = (buffer: ArrayBuffer): Float32Array => {
  const sampleCount = Math.floor(buffer.byteLength / 2);
  const view = new DataView(buffer);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }
  return samples;
};

export const createBreezeStartMessage = (config: BreezeStreamConfig) => ({
  type: 'start',
  ...(config.voiceId ? { voice_id: config.voiceId } : {}),
  instruction: config.instruction,
  cfg_scale: config.cfgScale ?? 1,
  seed: config.seed ?? BREEZE_TTS_DEFAULT_SEED,
  split_chars:
    config.splitChars ?? config.maximumChars ?? BREEZE_TTS_STREAM_MAX_CHARS,
});

export const createBreezeEndMessage = (pendingText: string) => ({
  type: 'end',
  ...(pendingText ? { text: pendingText } : {}),
});

export const takeTtsChunks = (
  text: string,
  options: {
    minimumChars?: number;
    maximumChars?: number;
    firstMinimumChars?: number;
    firstMaximumChars?: number;
    firstChunk?: boolean;
  } = {},
) => {
  const chunks: string[] = [];
  let current = '';
  let spokenChars = 0;
  for (const character of text) {
    current += character;
    if (!/\s/.test(character)) {
      spokenChars += 1;
    }
    const isFirstChunk = options.firstChunk === true && chunks.length === 0;
    const minimumChars = isFirstChunk
      ? (options.firstMinimumChars ?? BREEZE_TTS_STREAM_FIRST_MIN_CHARS)
      : (options.minimumChars ?? BREEZE_TTS_STREAM_MIN_CHARS);
    const maximumChars = isFirstChunk
      ? (options.firstMaximumChars ?? BREEZE_TTS_STREAM_FIRST_MAX_CHARS)
      : (options.maximumChars ?? BREEZE_TTS_STREAM_MAX_CHARS);
    const sentenceBoundary = /[。！？!?]/.test(character);
    const clauseBoundary = /[，、；;,:：]/.test(character);
    if (
      (sentenceBoundary && spokenChars >= minimumChars) ||
      (clauseBoundary && spokenChars >= minimumChars) ||
      spokenChars >= maximumChars
    ) {
      const chunk = current.trim();
      if (chunk) {
        chunks.push(chunk);
      }
      current = '';
      spokenChars = 0;
    }
  }
  return { chunks, remainder: current };
};

export const waitForAudioStart = (
  outcome: Promise<boolean>,
  timeoutMs: number,
) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void outcome
      .then((started) => {
        clearTimeout(timer);
        resolve(started);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
  });

const delay = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export class BreezeStreamingPlayer {
  private socket: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private outputDeviceId = '';
  private sampleRate = 24_000;
  private nextAudioAt = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private scheduleChain: Promise<void> = Promise.resolve();
  private readyPromise: Promise<void> | null = null;
  private startedPromise: Promise<void> | null = null;
  private donePromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private resolveStarted: (() => void) | null = null;
  private rejectStarted: ((error: Error) => void) | null = null;
  private resolveDone: (() => void) | null = null;
  private rejectDone: ((error: Error) => void) | null = null;
  private firstAudioReported = false;
  private cancelled = false;
  private sessionEnded = false;
  private started = false;
  private pendingText = '';
  private hasSentTextChunk = false;
  private readonly config: BreezeStreamConfig;

  constructor(config: BreezeStreamConfig) {
    this.config = config;
  }

  get isActive() {
    return Boolean(
      !this.cancelled && (this.socket || this.activeSources.size > 0),
    );
  }

  private rejectPending(error: Error) {
    this.rejectReady?.(error);
    this.rejectStarted?.(error);
    this.rejectDone?.(error);
  }

  private handleControlMessage(message: BreezeControlMessage) {
    switch (message.type) {
      case 'ready':
        this.sampleRate = message.sample_rate || 24_000;
        this.resolveReady?.();
        break;
      case 'started':
        this.resolveStarted?.();
        break;
      case 'speaking':
        if (message.text) {
          this.config.onSpeaking?.(message.text);
        }
        break;
      case 'done':
        this.sessionEnded = true;
        this.resolveDone?.();
        break;
      case 'error':
        this.rejectPending(
          new Error(message.message || 'Breeze streaming TTS failed'),
        );
        break;
      default:
        break;
    }
  }

  private async schedulePcm(buffer: ArrayBuffer) {
    if (this.cancelled || buffer.byteLength < 2) {
      return;
    }
    const audioContext = await this.ensureAudioContext();
    if (this.cancelled) {
      return;
    }
    const samples = pcm16ToFloat32(buffer);
    if (!samples.length) {
      return;
    }
    const audioBuffer = audioContext.createBuffer(
      1,
      samples.length,
      this.sampleRate,
    );
    audioBuffer.copyToChannel(samples, 0);
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    const startAt = Math.max(
      audioContext.currentTime +
        getAudioStartDelaySeconds(this.firstAudioReported),
      this.nextAudioAt,
    );
    source.start(startAt);
    this.nextAudioAt = startAt + audioBuffer.duration;
    this.activeSources.add(source);
    source.onended = () => this.activeSources.delete(source);
    if (!this.firstAudioReported) {
      this.firstAudioReported = true;
      this.config.onFirstAudio?.();
    }
  }

  private async ensureAudioContext() {
    const audioContext =
      this.audioContext ||
      new AudioContext({
        latencyHint: 'interactive',
      });
    this.audioContext = audioContext;
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    if (audioContext.state !== 'running') {
      throw new Error(`Breeze audio context is ${audioContext.state}`);
    }
    if (this.outputDeviceId) {
      await applyAudioSink(audioContext, this.outputDeviceId);
    }
    return audioContext;
  }

  async setSinkId(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    if (this.audioContext) {
      await applyAudioSink(this.audioContext, deviceId);
    }
  }

  private handleBinary(data: ArrayBuffer | Blob) {
    this.scheduleChain = this.scheduleChain
      .then(async () => {
        const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
        await this.schedulePcm(buffer);
      })
      .catch((error) => {
        this.rejectPending(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
  }

  private async connect() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.cancelled) {
        throw new Error('Breeze streaming TTS was cancelled');
      }
      try {
        return await new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(this.config.wsUrl);
          socket.binaryType = 'arraybuffer';
          const timer = window.setTimeout(() => {
            socket.close();
            reject(new Error('Breeze WebSocket connection timed out'));
          }, 1_500);
          socket.onopen = () => {
            window.clearTimeout(timer);
            resolve(socket);
          };
          socket.onerror = () => {
            window.clearTimeout(timer);
            reject(new Error('Breeze WebSocket connection failed'));
          };
        });
      } catch {
        await delay(300);
      }
    }
    throw new Error('Breeze WebSocket is unavailable');
  }

  async start() {
    const socket = await this.connect();
    this.socket = socket;
    const audioContextPromise = this.ensureAudioContext();
    void audioContextPromise.catch(() => {});
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.startedPromise = new Promise<void>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    this.donePromise = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          this.handleControlMessage(
            JSON.parse(event.data) as BreezeControlMessage,
          );
        } catch {
          this.rejectPending(new Error('Invalid Breeze TTS control message'));
        }
        return;
      }
      if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
        this.handleBinary(event.data);
      }
    };
    socket.onclose = () => {
      if (!this.sessionEnded && !this.cancelled) {
        this.rejectPending(new Error('Breeze TTS WebSocket closed'));
      }
    };
    socket.onerror = () => {
      if (!this.cancelled) {
        this.rejectPending(new Error('Breeze TTS WebSocket failed'));
      }
    };
    await this.readyPromise;
    socket.send(JSON.stringify(createBreezeStartMessage(this.config)));
    await this.startedPromise;
    await audioContextPromise;
    this.started = true;
    if (this.pendingText) {
      this.drainPendingText();
    }
  }

  appendText(text: string) {
    if (!text || this.cancelled || this.sessionEnded) {
      return;
    }
    this.pendingText += text;
    if (!this.started || this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.drainPendingText();
  }

  updateInstruction(instruction: string) {
    if (
      instruction &&
      !this.cancelled &&
      !this.sessionEnded &&
      this.socket?.readyState === WebSocket.OPEN
    ) {
      this.socket.send(JSON.stringify({ type: 'instruction', instruction }));
    }
  }

  async finish() {
    if (this.cancelled) {
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN && !this.sessionEnded) {
      this.socket.send(
        JSON.stringify(createBreezeEndMessage(this.pendingText)),
      );
      this.pendingText = '';
    }
    await Promise.race([
      this.donePromise,
      delay(120_000).then(() => {
        throw new Error('Breeze streaming TTS timed out');
      }),
    ]);
    await this.scheduleChain;
    const audioContext = this.audioContext;
    if (audioContext) {
      while (
        !this.cancelled &&
        this.nextAudioAt > audioContext.currentTime + 0.03
      ) {
        await delay(50);
      }
    }
    this.close();
  }

  cancel() {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    if (this.socket?.readyState === WebSocket.OPEN && !this.sessionEnded) {
      this.socket.send(JSON.stringify({ type: 'cancel' }));
    }
    this.activeSources.forEach((source) => source.stop());
    this.activeSources.clear();
    this.pendingText = '';
    this.resolveReady?.();
    this.resolveStarted?.();
    this.resolveDone?.();
    this.close();
  }

  private close() {
    this.socket?.close();
    this.socket = null;
    void this.audioContext?.close();
    this.audioContext = null;
  }

  private drainPendingText() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const { chunks, remainder } = takeTtsChunks(this.pendingText, {
      minimumChars: this.config.minimumChars,
      maximumChars: this.config.maximumChars,
      firstMinimumChars: this.config.firstMinimumChars,
      firstMaximumChars: this.config.firstMaximumChars,
      firstChunk: !this.hasSentTextChunk,
    });
    this.pendingText = remainder;
    this.hasSentTextChunk ||= chunks.length > 0;
    for (const chunk of chunks) {
      this.socket.send(JSON.stringify({ type: 'flush', text: chunk }));
    }
  }
}
