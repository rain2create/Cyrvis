/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

const asrMock = vi.hoisted(() => ({
  prepare: vi.fn(async () => ({ sessionId: 'prepared-session' })),
  claim: vi.fn(() => ({ claimed: true })),
  start: vi.fn(async () => ({ sessionId: 'started-session' })),
  sendAudio: vi.fn(async () => undefined),
  finish: vi.fn(async () => ({ text: 'confirm execution' })),
  cancel: vi.fn(),
  stopAll: vi.fn(),
}));

vi.mock('@main/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@main/store/setting', () => ({
  SettingStore: {
    getStore: () => ({
      voiceSttProvider: 'qwen-dashscope-streaming',
      voiceSttModel: '',
    }),
  },
}));

vi.mock('@main/services/streamingAsr', () => ({
  DashScopeStreamingAsrService: class {
    prepare = asrMock.prepare;
    claim = asrMock.claim;
    start = asrMock.start;
    sendAudio = asrMock.sendAudio;
    finish = asrMock.finish;
    cancel = asrMock.cancel;
    stopAll = asrMock.stopAll;
  },
}));

vi.mock('@main/services/tencentVoice', () => ({
  transcribeWithTenlai: vi.fn(),
}));
vi.mock('./local-asr', () => ({
  transcribeLocal: vi.fn(),
}));
vi.mock('./openai-asr', () => ({
  transcribeOpenAiCompatible: vi.fn(),
}));
vi.mock('./realtime-asr', () => ({
  transcribeRealtime: vi.fn(),
}));

import { CascadeVoiceProvider } from './cascade-provider';

type ProviderInternals = {
  conversation: {
    ask: (...args: unknown[]) => Promise<unknown>;
  };
  generation: number;
  speechActive: boolean;
  finishingSpeech: boolean;
  activeTurnId: string;
  asrSessionId: string;
  asrSendChain: Promise<void>;
  lastPartialText: string;
  connected: boolean;
  responseActive: boolean;
  runConversationTurn(text: string, generation: number): Promise<void>;
};

describe('CascadeVoiceProvider turn ownership', () => {
  it('retains screenshot IDs through the task speech queue and reports queued cancellation', () => {
    const onResponseStarted = vi.fn();
    const onReadoutState = vi.fn();
    const provider = new CascadeVoiceProvider({
      onResponseStarted,
      onReadoutState,
    });
    (provider as unknown as ProviderInternals).connected = true;
    provider.speak('当前任务进度。');
    provider.speak('第一张封面。', 'shot-a');
    provider.speak('第二张封面。', 'shot-b');
    provider.notifyPlaybackIdle();
    expect(onResponseStarted).toHaveBeenLastCalledWith({ readoutId: 'shot-a' });
    provider.cancelPendingSpeech();
    expect(onReadoutState).toHaveBeenCalledWith(
      'shot-b',
      'cancelled',
      expect.any(String),
    );
    provider.notifyPlaybackIdle();
    expect(onResponseStarted).toHaveBeenCalledTimes(2);
    provider.close();
  });

  it('routes a confirmed text request through the normal conversation pipeline', async () => {
    const provider = new CascadeVoiceProvider({});
    const internals = provider as unknown as ProviderInternals;
    const ask = vi
      .spyOn(internals.conversation, 'ask')
      .mockResolvedValue({ text: '已收到请求' } as any);
    expect(provider.submitText('查证刚才作品的封面背景')).toBe(true);
    await vi.waitFor(() =>
      expect(ask).toHaveBeenCalledWith(
        '查证刚才作品的封面背景',
        expect.anything(),
      ),
    );
    provider.close();
  });
  it('does not start an LLM turn when the final transcript is consumed', async () => {
    const onTranscript = vi.fn(() => true);
    const provider = new CascadeVoiceProvider({ onTranscript });
    const internals = provider as unknown as ProviderInternals;
    const ask = vi.spyOn(internals.conversation, 'ask');

    internals.speechActive = true;
    internals.finishingSpeech = false;
    internals.activeTurnId = 'turn-1';
    internals.generation = 0;
    internals.asrSessionId = 'session-1';
    internals.asrSendChain = Promise.resolve();
    internals.lastPartialText = '';

    provider.finishUtterance();

    await vi.waitFor(() => {
      expect(onTranscript).toHaveBeenCalledWith('confirm execution', true);
    });
    expect(ask).not.toHaveBeenCalled();
    provider.close();
  });

  it('drops a stale turn after a deterministic route cancels the response', async () => {
    const provider = new CascadeVoiceProvider({});
    const internals = provider as unknown as ProviderInternals;
    const ask = vi.spyOn(internals.conversation, 'ask');
    internals.generation = 2;

    await internals.runConversationTurn('confirm execution', 1);

    expect(ask).not.toHaveBeenCalled();
    provider.close();
  });

  it('queues proactive task speech until the current playback is idle', () => {
    const onAssistantText = vi.fn();
    const onSpeechText = vi.fn();
    const onResponseStarted = vi.fn();
    const provider = new CascadeVoiceProvider({
      onAssistantText,
      onSpeechText,
      onResponseStarted,
    });
    (provider as unknown as ProviderInternals).connected = true;

    provider.speak('任务已开始。');
    provider.speak('任务已经完成。');
    provider.speak('任务结果已校验。');

    expect(onResponseStarted).toHaveBeenCalledTimes(1);
    expect(onSpeechText).toHaveBeenCalledTimes(1);
    expect(onAssistantText).toHaveBeenCalledTimes(1);

    provider.notifyPlaybackIdle();

    expect(onResponseStarted).toHaveBeenCalledTimes(2);
    expect(onSpeechText).toHaveBeenLastCalledWith('任务已经完成。', true);
    provider.notifyPlaybackIdle();
    expect(onSpeechText).toHaveBeenLastCalledWith('任务结果已校验。', true);
    provider.close();
  });

  it('drops queued task speech when the task terminal event supersedes it', () => {
    const onSpeechText = vi.fn();
    const provider = new CascadeVoiceProvider({ onSpeechText });
    (provider as unknown as ProviderInternals).connected = true;

    provider.speak('任务仍在处理。');
    provider.speak('任务已经完成。');
    provider.cancelPendingSpeech();
    provider.notifyPlaybackIdle();

    expect(onSpeechText).toHaveBeenCalledTimes(1);
    expect(onSpeechText).not.toHaveBeenCalledWith('任务已经完成。', true);
    provider.close();
  });

  it('keeps task speech queued across an in-flight response and audio drain', () => {
    const onSpeechText = vi.fn();
    const provider = new CascadeVoiceProvider({ onSpeechText });
    const internals = provider as unknown as ProviderInternals;
    internals.connected = true;
    internals.responseActive = true;

    provider.speak('任务已开始。');
    provider.notifyPlaybackIdle();
    expect(onSpeechText).not.toHaveBeenCalled();

    internals.responseActive = false;
    provider.notifyPlaybackIdle();
    expect(onSpeechText).toHaveBeenCalledWith('任务已开始。', true);
    provider.close();
  });
});
