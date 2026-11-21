/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  QwenTtsRealtimeLanguage,
  QwenTtsRealtimeMode,
  QwenTtsRealtimeStreamEvent,
} from '@shared/qwenTtsRealtime';

import {
  BREEZE_TTS_FIRST_AUDIO_BUFFER_MS,
  applyAudioSink,
  getAudioStartDelaySeconds,
  pcm16ToFloat32,
  takeTtsChunks,
} from './breezeTtsStream';

export type QwenTtsStreamConfig = {
  requestId: string;
  mode?: QwenTtsRealtimeMode;
  language?: QwenTtsRealtimeLanguage;
  minimumChars?: number;
  maximumChars?: number;
  firstMinimumChars?: number;
  firstMaximumChars?: number;
  onSpeaking?: (text: string) => void;
  onFirstAudio?: () => void;
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const base64ToArrayBuffer = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
};

export class QwenTtsStreamingPlayer {
  private sessionId = '';
  private unsubscribe: (() => void) | null = null;
  private audioContext: AudioContext | null = null;
  private audioContextPromise: Promise<AudioContext> | null = null;
  private outputDeviceId = '';
  private sampleRate = 24_000;
  private nextAudioAt = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private scheduleChain: Promise<void> = Promise.resolve();
  private sendChain: Promise<void> = Promise.resolve();
  private finishedPromise: Promise<void> | null = null;
  private resolveFinished: (() => void) | null = null;
  private rejectFinished: ((error: Error) => void) | null = null;
  private firstAudioReported = false;
  private cancelled = false;
  private started = false;
  private sessionFinished = false;
  private pendingText = '';
  private hasSentTextChunk = false;
  private readonly config: QwenTtsStreamConfig;

  constructor(config: QwenTtsStreamConfig) {
    this.config = config;
  }

  get isActive() {
    return Boolean(this.sessionId && !this.cancelled && !this.sessionFinished);
  }

  private async ensureAudioContext() {
    if (!this.audioContextPromise) {
      this.audioContextPromise = (async () => {
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
          throw new Error(`Qwen TTS audio context is ${audioContext.state}`);
        }
        if (this.outputDeviceId) {
          await applyAudioSink(audioContext, this.outputDeviceId);
        }
        return audioContext;
      })();
    }
    return this.audioContextPromise;
  }

  async setSinkId(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    if (this.audioContext) {
      await applyAudioSink(this.audioContext, deviceId);
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

  private handleEvent(event: QwenTtsRealtimeStreamEvent) {
    if (event.sessionId !== this.sessionId) {
      return;
    }
    if (event.type === 'audio') {
      this.sampleRate = event.sampleRate || this.sampleRate;
      this.scheduleChain = this.scheduleChain
        .then(() => this.schedulePcm(base64ToArrayBuffer(event.delta)))
        .catch((error) => {
          this.rejectFinished?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      return;
    }
    if (event.type === 'completed') {
      this.sessionFinished = true;
      this.resolveFinished?.();
      return;
    }
    if (event.type === 'error') {
      this.rejectFinished?.(new Error(event.error));
      return;
    }
    if (event.type === 'closed' && !this.sessionFinished && !this.cancelled) {
      this.rejectFinished?.(new Error('Qwen Realtime TTS closed unexpectedly'));
    }
  }

  async start() {
    if (this.started) {
      return;
    }
    this.unsubscribe = window.electron.voice.onQwenTtsEvent((event) => {
      if (event?.sessionId) {
        this.handleEvent(event);
      }
    });
    const audioContextPromise = this.ensureAudioContext();
    void audioContextPromise.catch(() => {});
    const result = await window.electron.voice.startQwenTtsSession({
      requestId: this.config.requestId,
      mode: this.config.mode,
      language: this.config.language,
    });
    if (this.cancelled) {
      await window.electron.voice.cancelQwenTtsSession({
        sessionId: result.sessionId,
      });
      return;
    }
    this.sessionId = result.sessionId;
    this.sampleRate = result.sampleRate;
    await audioContextPromise;
    this.started = true;
    if (this.pendingText) {
      this.drainPendingText();
    }
  }

  appendText(text: string) {
    if (!text || this.cancelled || this.sessionFinished) {
      return;
    }
    this.pendingText += text;
    if (!this.started) {
      return;
    }
    this.drainPendingText();
  }

  private drainPendingText() {
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
      this.config.onSpeaking?.(chunk);
      this.sendChain = this.sendChain.then(async () => {
        if (!this.sessionId || this.cancelled) {
          return;
        }
        await window.electron.voice.appendQwenTtsText({
          sessionId: this.sessionId,
          text: chunk,
          commit: true,
        });
      });
    }
  }

  async finish() {
    if (this.cancelled || !this.sessionId) {
      return;
    }
    if (this.finishedPromise) {
      return this.finishedPromise;
    }
    this.finishedPromise = new Promise<void>((resolve, reject) => {
      this.resolveFinished = resolve;
      this.rejectFinished = reject;
    });
    if (this.pendingText) {
      const text = this.pendingText;
      this.pendingText = '';
      this.config.onSpeaking?.(text);
      this.sendChain = this.sendChain.then(() =>
        window.electron.voice.appendQwenTtsText({
          sessionId: this.sessionId,
          text,
          commit: true,
        }),
      );
    }
    try {
      await this.sendChain;
      await window.electron.voice.finishQwenTtsSession({
        sessionId: this.sessionId,
      });
      await Promise.race([
        this.finishedPromise,
        delay(120_000).then(() => {
          throw new Error('Qwen Realtime TTS timed out');
        }),
      ]);
      await this.scheduleChain;
      await this.waitForPlayback();
    } finally {
      this.close();
    }
  }

  cancel() {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    const sessionId = this.sessionId;
    this.sessionId = '';
    this.activeSources.forEach((source) => source.stop());
    this.activeSources.clear();
    this.pendingText = '';
    this.resolveFinished?.();
    if (sessionId) {
      void window.electron.voice
        .cancelQwenTtsSession({ sessionId })
        .catch(() => {});
    }
    this.close();
  }

  private async waitForPlayback() {
    const audioContext = this.audioContext;
    if (!audioContext) {
      return;
    }
    while (
      !this.cancelled &&
      this.nextAudioAt > audioContext.currentTime + 0.03
    ) {
      await delay(50);
    }
  }

  private close() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    void this.audioContext?.close();
    this.audioContext = null;
    this.audioContextPromise = null;
  }
}

export const QWEN_TTS_FIRST_AUDIO_BUFFER_MS = BREEZE_TTS_FIRST_AUDIO_BUFFER_MS;
