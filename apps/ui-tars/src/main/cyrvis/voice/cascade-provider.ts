/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import { logger } from '@main/logger';
import { SettingStore } from '@main/store/setting';
import { DashScopeStreamingAsrService } from '@main/services/streamingAsr';
import { transcribeWithTenlai } from '@main/services/tencentVoice';
import type { StreamingAsrEvent } from '@shared/asrStream';
import {
  resolveVoiceSttProvider,
  type ResolvedVoiceSttProvider,
} from '@shared/voice';

import { CascadeConversationClient } from './cascade-conversation';
import { transcribeLocal } from './local-asr';
import { transcribeOpenAiCompatible } from './openai-asr';
import { transcribeRealtime } from './realtime-asr';
import type {
  InteractiveVoiceProvider,
  VoiceProviderCallbacks,
} from './provider';
import { cleanSpeechText } from './tars-speech';
import type { QwenToolDefinition } from './tools';

const MAX_MUTE_BUFFER_MS = 1_000;

const abortError = () =>
  new DOMException('The operation was aborted', 'AbortError');

/**
 * Main-process ASR + text-LLM portion of the UI-tars cascade.
 *
 * UI-tars owns microphone capture, VAD, barge-in and TTS playback in the
 * renderer. This provider therefore accepts explicit utterance boundaries and
 * emits assistant text; it must not synthesize or play audio itself.
 */
export class CascadeVoiceProvider implements InteractiveVoiceProvider {
  private readonly callbacks: VoiceProviderCallbacks;
  private readonly asr: DashScopeStreamingAsrService;
  private readonly conversation: CascadeConversationClient;
  private sttProvider: ResolvedVoiceSttProvider = 'qwen-dashscope-streaming';

  private connected = false;
  private closed = false;
  private generation = 0;
  private activeTurnId = '';
  private asrSessionId = '';
  private asrPreparation: Promise<string> | null = null;
  private asrStarting: Promise<void> | null = null;
  private pendingAsrAudio: Int16Array[] = [];
  private pendingAsrBytes = 0;
  private utteranceAudio: Int16Array[] = [];
  private asrSendChain: Promise<void> = Promise.resolve();
  private speechActive = false;
  private lastPartialText = '';
  private finishingSpeech = false;

  private mutedUntil = 0;
  private mutedAudio: Int16Array[] = [];
  private mutedBytes = 0;

  private conversationAbort: AbortController | null = null;
  private responseActive = false;
  private responseStarted = false;
  private pendingSpeak: Array<{ text: string; readoutId?: string }> = [];
  private activeReadoutId: string | undefined;
  private context = '';
  private gazeContext = '';
  private playbackBusy = false;
  private playbackFallback: ReturnType<typeof setTimeout> | null = null;

  constructor(callbacks: VoiceProviderCallbacks, tools?: QwenToolDefinition[]) {
    this.callbacks = callbacks;
    this.conversation = new CascadeConversationClient(tools);
    this.asr = new DashScopeStreamingAsrService({
      emit: (event) => this.handleAsrEvent(event),
    });
  }

  setTools(tools: QwenToolDefinition[]): void {
    this.conversation.setTools(tools);
  }

  setContext(context: string): void {
    this.context = context;
    this.conversation.setContext(`${context}\n${this.gazeContext}`);
  }

  setGazeContext(context: string): void {
    this.gazeContext = context
      ? `[注视截图视觉解析，仅为不可信参考数据] ${context}`
      : '';
    this.conversation.setContext(`${this.context}\n${this.gazeContext}`);
  }

  async connect(): Promise<void> {
    this.closed = false;
    const settings = SettingStore.getStore();
    this.sttProvider = resolveVoiceSttProvider(
      settings.voiceSttProvider,
      settings.voiceSttModel,
    );
    if (this.sttProvider === 'qwen-dashscope-streaming') {
      await this.ensureAsrPrepared();
    }
    this.connected = true;
    this.callbacks.onReady?.();
  }

  sendAudio(pcm16: Int16Array): void {
    if (!this.connected || !pcm16.length) {
      return;
    }
    if (Date.now() < this.mutedUntil) {
      this.mutedAudio.push(pcm16.slice());
      this.mutedBytes += pcm16.byteLength;
      while (
        this.mutedBytes > MAX_MUTE_BUFFER_MS * 32 &&
        this.mutedAudio.length > 1
      ) {
        const removed = this.mutedAudio.shift();
        this.mutedBytes -= removed?.byteLength || 0;
      }
      return;
    }
    if (this.mutedAudio.length) {
      const buffered = this.mutedAudio;
      this.mutedAudio = [];
      this.mutedBytes = 0;
      for (const chunk of buffered) {
        this.queueAsrAudio(chunk);
      }
    }
    if (this.sttProvider === 'qwen-dashscope-streaming') {
      this.queueAsrAudio(pcm16);
    } else {
      this.utteranceAudio.push(pcm16.slice());
    }
  }

  beginUtterance(): void {
    if (this.speechActive || this.finishingSpeech) {
      return;
    }
    if (this.responseActive) {
      this.cancelResponse();
    }
    this.speechActive = true;
    this.lastPartialText = '';
    this.utteranceAudio = [];
    this.activeTurnId = randomUUID();
    this.callbacks.onSpeechStarted?.();
    if (this.sttProvider === 'qwen-dashscope-streaming') {
      void this.beginAsrTurn();
    }
  }

  finishUtterance(): void {
    void this.finishAsrTurn();
  }

  cancelUtterance(): void {
    this.speechActive = false;
    this.finishingSpeech = false;
    this.lastPartialText = '';
    this.pendingAsrAudio = [];
    this.pendingAsrBytes = 0;
    this.utteranceAudio = [];
    if (this.asrSessionId) {
      this.asr.cancel(this.asrSessionId);
      this.asrSessionId = '';
    }
  }

  private queueAsrAudio(pcm16: Int16Array) {
    if (!this.speechActive || this.finishingSpeech) {
      return;
    }
    if (!this.asrSessionId) {
      this.pendingAsrAudio.push(pcm16.slice());
      this.pendingAsrBytes += pcm16.byteLength;
      while (this.pendingAsrBytes > 16_000 * 2 * 15) {
        const removed = this.pendingAsrAudio.shift();
        this.pendingAsrBytes -= removed?.byteLength || 0;
      }
      return;
    }
    const sessionId = this.asrSessionId;
    this.asrSendChain = this.asrSendChain
      .then(() =>
        this.asr.sendAudio({
          sessionId,
          audio: pcm16.slice().buffer as ArrayBuffer,
        }),
      )
      .catch((error: unknown) => {
        if (sessionId !== this.asrSessionId) {
          return;
        }
        this.speechActive = false;
        this.callbacks.onSpeechStopped?.();
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
  }

  private async ensureAsrPrepared(): Promise<string> {
    if (this.closed) {
      throw new Error('Cascade voice provider is closed');
    }
    if (this.asrSessionId) {
      return this.asrSessionId;
    }
    if (!this.asrPreparation) {
      this.asrPreparation = this.asr
        .prepare()
        .then(({ sessionId }) => sessionId)
        .finally(() => {
          this.asrPreparation = null;
        });
    }
    return this.asrPreparation;
  }

  private async beginAsrTurn(): Promise<void> {
    if (this.asrStarting || this.asrSessionId || this.finishingSpeech) {
      return;
    }
    const generation = this.generation;
    const turnId = this.activeTurnId;
    this.asrStarting = (async () => {
      let preparedSessionId = '';
      try {
        preparedSessionId = await this.ensureAsrPrepared();
      } catch {
        preparedSessionId = '';
      }
      let sessionId = '';
      if (preparedSessionId) {
        const claim = this.asr.claim({ sessionId: preparedSessionId, turnId });
        if (claim.claimed) {
          sessionId = preparedSessionId;
        } else {
          this.asr.cancel(preparedSessionId);
        }
      }
      if (!sessionId) {
        const started = await this.asr.start({
          turnId,
          sampleRate: 16_000,
        });
        sessionId = started.sessionId;
      }
      if (generation !== this.generation || turnId !== this.activeTurnId) {
        this.asr.cancel(sessionId);
        return;
      }
      this.asrSessionId = sessionId;
      const buffered = this.pendingAsrAudio;
      this.pendingAsrAudio = [];
      this.pendingAsrBytes = 0;
      for (const chunk of buffered) {
        await this.asr.sendAudio({
          sessionId,
          audio: chunk.slice().buffer as ArrayBuffer,
        });
      }
    })()
      .catch((error: unknown) => {
        this.speechActive = false;
        this.callbacks.onSpeechStopped?.();
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      })
      .finally(() => {
        this.asrStarting = null;
      });
    await this.asrStarting;
  }

  private async finishAsrTurn(): Promise<void> {
    if (!this.speechActive || this.finishingSpeech) {
      return;
    }
    this.finishingSpeech = true;
    this.speechActive = false;
    this.callbacks.onSpeechStopped?.();
    this.callbacks.onUtteranceCommitted?.();

    const turnId = this.activeTurnId;
    const generation = this.generation;

    try {
      let text = '';
      if (this.sttProvider === 'qwen-dashscope-streaming') {
        if (this.asrStarting) {
          await this.asrStarting;
        }
        if (!this.asrSessionId) {
          throw new Error(
            'Streaming ASR session was not ready for finalization',
          );
        }
        const sessionId = this.asrSessionId;
        this.asrSessionId = '';
        await this.asrSendChain;
        const result = await this.asr.finish(sessionId);
        text = (result.text || this.lastPartialText).trim();
      } else if (this.sttProvider === 'local-sherpa') {
        text = (await transcribeLocal(this.utteranceAudio)).trim();
      } else if (this.sttProvider === 'realtime-asr') {
        text = (await transcribeRealtime(this.utteranceAudio)).trim();
      } else {
        if (this.sttProvider === 'tenlai-async') {
          const settings = SettingStore.getStore();
          const total = this.utteranceAudio.reduce(
            (sum, chunk) => sum + chunk.length,
            0,
          );
          const pcm = Buffer.alloc(total * 2);
          let offset = 0;
          for (const chunk of this.utteranceAudio) {
            for (const sample of chunk) {
              pcm.writeInt16LE(sample, offset);
              offset += 2;
            }
          }
          const result = await transcribeWithTenlai(
            { audioBase64: pcm.toString('base64') },
            {
              // secretlint-disable-next-line @secretlint/secretlint-rule-pattern
              apiKey: settings.voiceSttApiKey?.trim() || '',
              baseUrl: settings.voiceSttBaseUrl,
              model: settings.voiceSttModel,
            },
          );
          text = result.text.trim();
        } else {
          text = (
            await transcribeOpenAiCompatible(
              this.utteranceAudio,
              SettingStore.getStore().voiceLanguage,
            )
          ).trim();
        }
      }
      if (generation !== this.generation || turnId !== this.activeTurnId) {
        return;
      }
      const consumed = this.callbacks.onTranscript?.(text, true);
      if (consumed === true) {
        logger.info('[CascadeVoice] final transcript consumed by front-end', {
          chars: Array.from(text).length,
        });
        return;
      }
      if (text) {
        void this.runConversationTurn(text, generation);
      }
    } catch (error) {
      const partial = this.lastPartialText.trim();
      if (
        Array.from(partial).length >= 4 &&
        generation === this.generation &&
        turnId === this.activeTurnId
      ) {
        logger.warn('[CascadeVoice] ASR finalize failed; using partial', {
          chars: partial.length,
          error: error instanceof Error ? error.message : String(error),
        });
        const consumed = this.callbacks.onTranscript?.(partial, true);
        if (consumed === true) {
          logger.info(
            '[CascadeVoice] partial transcript consumed by front-end',
            {
              chars: Array.from(partial).length,
            },
          );
        } else {
          void this.runConversationTurn(partial, generation);
        }
      } else if (!/aborted|cancel/i.test(String(error))) {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    } finally {
      this.finishingSpeech = false;
      this.lastPartialText = '';
      this.utteranceAudio = [];
      if (this.sttProvider === 'qwen-dashscope-streaming') {
        void this.ensureAsrPrepared().catch((error: unknown) => {
          logger.warn('[CascadeVoice] ASR prewarm failed', error);
        });
      }
    }
  }

  private async runConversationTurn(
    text: string,
    generation: number,
  ): Promise<void> {
    // A deterministic front-end command may cancel the current response while
    // handling the transcript. Never start a stale LLM turn after that.
    if (generation !== this.generation || !text.trim()) {
      return;
    }
    this.activeReadoutId = undefined;
    const abort = new AbortController();
    this.conversationAbort?.abort();
    this.conversationAbort = abort;
    this.responseActive = true;
    this.responseStarted = false;
    let finalText = '';

    try {
      const result = await this.conversation.ask(text, {
        signal: abort.signal,
        callbacks: {
          onAssistantDelta: (delta) => {
            if (generation !== this.generation || abort.signal.aborted) {
              return;
            }
            this.ensureResponseStarted();
            this.callbacks.onAssistantText?.(delta, false);
          },
          onSpeechDelta: (delta) => {
            if (generation !== this.generation || abort.signal.aborted) {
              return;
            }
            this.ensureResponseStarted();
            this.emitSpeechText(delta, false);
          },
          onToolCall: (call) => {
            if (generation === this.generation && !abort.signal.aborted) {
              this.callbacks.onToolCall?.(call);
            }
          },
        },
      });
      if (generation !== this.generation || abort.signal.aborted) {
        return;
      }
      finalText = result.text.trim() || '我暂时没有生成有效回复。';
      this.callbacks.onAssistantText?.(finalText, true);
      const finalSpeechText = cleanSpeechText(finalText);
      if (finalSpeechText) {
        this.ensureResponseStarted();
        this.emitSpeechText(finalSpeechText, true);
      }
      this.callbacks.onResponseDone?.();
    } catch (error) {
      if (abort.signal.aborted || generation !== this.generation) {
        return;
      }
      if (this.responseStarted) {
        this.callbacks.onResponseDone?.();
      }
      this.callbacks.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      if (this.conversationAbort === abort) {
        this.conversationAbort = null;
      }
      if (generation === this.generation) {
        this.responseActive = false;
        this.responseStarted = false;
        this.pumpPendingSpeech();
      }
    }
  }

  private ensureResponseStarted() {
    if (this.responseStarted) {
      return;
    }
    this.responseStarted = true;
    if (this.activeReadoutId)
      this.callbacks.onReadoutState?.(this.activeReadoutId, 'generating');
    this.callbacks.onResponseStarted?.(
      this.activeReadoutId ? { readoutId: this.activeReadoutId } : undefined,
    );
  }

  private handleAsrEvent(event: StreamingAsrEvent): void {
    if (event.turnId && event.turnId !== this.activeTurnId) {
      return;
    }
    if (event.type === 'partial') {
      this.lastPartialText = event.text;
      this.callbacks.onTranscript?.(event.text, false);
      return;
    }
    if (event.type === 'final' && event.text) {
      this.lastPartialText = event.text;
      return;
    }
    if (event.type === 'error') {
      if (!event.turnId) {
        logger.warn('[CascadeVoice] Prepared ASR session expired', {
          error: event.error,
        });
        return;
      }
      this.callbacks.onError?.(new Error(event.error));
    }
  }

  sendToolResult(callId: string, output: string, readoutId?: string): void {
    if (readoutId) {
      this.activeReadoutId = readoutId;
      this.responseStarted = false;
      this.callbacks.onReadoutState?.(readoutId, 'queued');
    }
    this.conversation.sendToolResult(callId, output);
  }

  submitText(text: string): boolean {
    if (!text.trim()) return false;
    void this.runConversationTurn(text, this.generation);
    return true;
  }
  isReady(): boolean {
    return this.connected;
  }

  cancelResponse(): void {
    this.cancelPendingSpeech();
    this.activeReadoutId = undefined;
    this.generation += 1;
    this.conversationAbort?.abort();
    this.conversationAbort = null;
    this.conversation.cancelPendingToolResults(abortError());
    this.pendingSpeak = [];
    this.playbackBusy = false;
    this.clearPlaybackFallback();
    this.responseActive = false;
    this.responseStarted = false;
    if (this.asrSessionId) {
      this.asr.cancel(this.asrSessionId);
      this.asrSessionId = '';
    }
    this.speechActive = false;
    this.finishingSpeech = false;
    this.lastPartialText = '';
    this.pendingAsrAudio = [];
    this.pendingAsrBytes = 0;
    this.utteranceAudio = [];
    this.asrSendChain = Promise.resolve();
    if (this.sttProvider === 'qwen-dashscope-streaming') {
      void this.ensureAsrPrepared().catch(() => undefined);
    }
  }

  bargeIn(_options: { forceCommit?: boolean } = {}): void {
    this.cancelResponse();
    this.mutedAudio = [];
    this.mutedBytes = 0;
    this.mutedUntil = 0;
  }

  clearAudioBuffer(): void {
    this.cancelUtterance();
    if (this.sttProvider === 'qwen-dashscope-streaming') {
      void this.ensureAsrPrepared().catch(() => undefined);
    }
  }

  muteMicFor(ms: number): void {
    this.mutedUntil = Math.max(this.mutedUntil, Date.now() + ms);
  }

  notifyPlaybackIdle(_tailMs = 0): void {
    this.playbackBusy = false;
    this.clearPlaybackFallback();
    this.callbacks.onPlaybackIdle?.();
    this.pumpPendingSpeech();
  }

  endPtt(): void {
    this.finishUtterance();
  }

  speakExact(text: string): void {
    this.speak(text);
  }

  speak(text: string, readoutId?: string): void {
    if (readoutId) this.callbacks.onReadoutState?.(readoutId, 'queued');
    if (readoutId && !this.connected) {
      this.callbacks.onReadoutState?.(
        readoutId,
        'failed',
        '语音连接已断开，请重播。',
      );
      return;
    }
    const speech = cleanSpeechText(text);
    if (!speech) {
      return;
    }
    if (this.responseActive || this.playbackBusy) {
      this.pendingSpeak.push({ text: speech, readoutId });
      return;
    }
    this.generation += 1;
    this.responseActive = true;
    this.responseStarted = false;
    this.responseStarted = true;
    if (readoutId) this.callbacks.onReadoutState?.(readoutId, 'generating');
    this.callbacks.onResponseStarted?.(readoutId ? { readoutId } : undefined);
    this.callbacks.onAssistantText?.(speech, true);
    this.emitSpeechText(speech, true);
    this.callbacks.onResponseDone?.();
    this.responseActive = false;
    this.responseStarted = false;
  }

  cancelPendingSpeech(): void {
    for (const pending of this.pendingSpeak) {
      if (pending.readoutId)
        this.callbacks.onReadoutState?.(
          pending.readoutId,
          'cancelled',
          '排队播报已取消。',
        );
    }
    this.pendingSpeak = [];
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    this.pendingSpeak = [];
    this.playbackBusy = false;
    this.clearPlaybackFallback();
    this.cancelResponse();
    this.asr.stopAll();
    this.callbacks.onClose?.();
  }

  private emitSpeechText(text: string, final: boolean): void {
    if (!cleanSpeechText(text)) {
      return;
    }
    this.playbackBusy = true;
    this.armPlaybackFallback(text);
    this.callbacks.onSpeechText?.(text, final);
  }

  private pumpPendingSpeech(): void {
    const next = this.pendingSpeak[0];
    if (!next || !this.connected || this.responseActive || this.playbackBusy) {
      return;
    }
    this.pendingSpeak.shift();
    this.speak(next.text, next.readoutId);
  }

  private armPlaybackFallback(text: string): void {
    this.clearPlaybackFallback();
    const estimatedMs = Math.max(
      5_000,
      Math.min(90_000, Array.from(text).length * 320 + 3_000),
    );
    this.playbackFallback = setTimeout(() => {
      this.playbackFallback = null;
      if (!this.playbackBusy) {
        return;
      }
      logger.warn('[CascadeVoice] playback idle fallback');
      this.playbackBusy = false;
      this.callbacks.onPlaybackIdle?.();
      this.pumpPendingSpeech();
    }, estimatedMs);
    this.playbackFallback.unref?.();
  }

  private clearPlaybackFallback(): void {
    if (this.playbackFallback) {
      clearTimeout(this.playbackFallback);
      this.playbackFallback = null;
    }
  }
}
