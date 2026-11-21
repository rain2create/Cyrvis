/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { QwenOmniProvider } from './qwen-omni';
import type { QwenToolDefinition } from './tools';
import WebSocket from 'ws';

const sockets = vi.hoisted(() => [] as FakeWebSocket[]);

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 0;
  send = vi.fn();
  close = vi.fn(() => {
    if (this.readyState === 0) {
      // ws emits this asynchronously when close() aborts the handshake.
      this.abortPending = true;
    }
    this.readyState = 3;
  });
  abortPending = false;

  constructor() {
    super();
    sockets.push(this);
  }

  flushClose(): void {
    if (this.abortPending) {
      this.abortPending = false;
      this.emit(
        'error',
        new Error('WebSocket was closed before the connection was established'),
      );
    }
    this.emit('close', 1006, Buffer.alloc(0));
  }

  ready(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'session.updated' })),
    );
  }
}

vi.mock('ws', () => ({
  default: Object.assign(
    function () {
      return new FakeWebSocket();
    },
    { OPEN: 1 },
  ),
}));

const providers: QwenOmniProvider[] = [];
const setup = (model?: string, endpoint?: string) => {
  vi.useFakeTimers();
  const callbacks = {
    onError: vi.fn(),
    onClose: vi.fn(),
    onReady: vi.fn(),
    onAudio: vi.fn(),
    onToolCall: vi.fn(),
    onReadoutState: vi.fn(),
    onResponseStarted: vi.fn(),
    onAssistantText: vi.fn(),
  };
  const provider = new QwenOmniProvider({
    apiKey: 'test-key',
    model,
    endpoint,
    callbacks,
    connectTimeoutMs: 100,
  });
  providers.push(provider);
  return { provider, callbacks };
};

afterEach(() => {
  providers.splice(0).forEach((provider) => provider.close());
  sockets.length = 0;
  vi.useRealTimers();
});

const receive = (socket: FakeWebSocket, event: object) =>
  socket.emit('message', Buffer.from(JSON.stringify(event)));
const sent = (socket: FakeWebSocket) =>
  socket.send.mock.calls.map(([data]) => JSON.parse(data));

describe('Qwen companion voices', () => {
  it('keeps exact workflow speech and screenshot IDs separate in the shared FIFO queue', async () => {
    const { provider, callbacks } = setup('qwen-audio-3.0-realtime-plus');
    const connecting = provider.connect();
    sockets[0].ready();
    await connecting;
    receive(sockets[0], {
      type: 'conversation.item.created',
      item: { id: 'user-a', role: 'user' },
    });
    provider.cancelResponse();
    provider.speakExact('机票比较已完成。');
    provider.speak('这是新的封面。', 'shot-next');
    await vi.advanceTimersByTimeAsync(401);
    expect(
      sent(sockets[0]).some(
        (item) =>
          item.type === 'conversation.item.delete' && item.item_id === 'user-a',
      ),
    ).toBe(true);
    receive(sockets[0], { type: 'response.created' });
    expect(callbacks.onResponseStarted).toHaveBeenLastCalledWith(undefined);
    receive(sockets[0], {
      type: 'response.done',
      response: { status: 'completed' },
    });
    receive(sockets[0], { type: 'response.created' });
    expect(callbacks.onResponseStarted).toHaveBeenLastCalledWith({
      readoutId: 'shot-next',
    });
  });

  it('records one assistant turn when both text and audio transcript events are emitted', async () => {
    const { provider, callbacks } = setup('qwen-audio-3.0-realtime-plus');
    const connected = provider.connect();
    sockets[0].ready();
    await connected;
    receive(sockets[0], { type: 'response.created' });
    receive(sockets[0], {
      type: 'response.text.delta',
      delta: '我来帮你播放。',
    });
    receive(sockets[0], { type: 'response.text.done', text: '我来帮你播放。' });
    receive(sockets[0], {
      type: 'response.audio_transcript.delta',
      delta: '我来帮你播放。',
    });
    receive(sockets[0], {
      type: 'response.audio_transcript.done',
      transcript: '我来帮你播放。',
    });
    expect(
      callbacks.onAssistantText.mock.calls.filter((call) => call[1]),
    ).toEqual([['我来帮你播放。', true]]);
  });
  it('correlates queued screenshot speech with its generated audio, without claiming device playback', async () => {
    const { provider, callbacks } = setup('qwen-audio-3.0-realtime-plus');
    const connected = provider.connect();
    sockets[0].ready();
    await connected;
    provider.speak('这里是音乐封面。', 'shot-a');
    expect(callbacks.onReadoutState).toHaveBeenCalledWith('shot-a', 'queued');
    receive(sockets[0], { type: 'response.created', response_id: 'voice-a' });
    expect(callbacks.onResponseStarted).toHaveBeenCalledWith({
      readoutId: 'shot-a',
    });
    receive(sockets[0], {
      type: 'response.audio.delta',
      delta: Buffer.from(new Int16Array([10, 20]).buffer).toString('base64'),
    });
    expect(callbacks.onReadoutState).toHaveBeenCalledWith('shot-a', 'audio');
    expect(
      callbacks.onReadoutState.mock.calls.some((call) =>
        ['playing', 'spoken'].includes(call[1]),
      ),
    ).toBe(false);
  });

  it('keeps the screenshot context when memory refreshes and reports a missing audio response', async () => {
    const { provider, callbacks } = setup('qwen-audio-3.0-realtime-plus');
    const connected = provider.connect();
    sockets[0].ready();
    await connected;
    provider.setGazeContext(
      '{"screenshotId":"shot-a","observation":"TEST ALBUM"}',
    );
    provider.setContext('用户偏好轻音乐');
    const updates = sent(sockets[0]).filter(
      (item) => item.type === 'session.update',
    );
    expect(updates.at(-1).session.instructions).toContain('TEST ALBUM');
    expect(updates.at(-1).session.instructions).toContain('轻音乐');
    provider.speak('这里是 TEST ALBUM。', 'shot-a');
    receive(sockets[0], { type: 'response.created' });
    receive(sockets[0], {
      type: 'response.done',
      response: { status: 'completed' },
    });
    expect(callbacks.onReadoutState).toHaveBeenCalledWith(
      'shot-a',
      'failed',
      expect.stringContaining('没有返回可播放音频'),
    );
  });
  it('drops the stale user turn before an exact deterministic line', async () => {
    const { provider } = setup('qwen-audio-3.0-realtime-plus');
    const connected = provider.connect();
    sockets[0].ready();
    await connected;

    receive(sockets[0], {
      type: 'conversation.item.created',
      item: { id: 'item_user_1', role: 'user' },
    });
    provider.speakExact('我比了 5 个平台。');

    const messages = sent(sockets[0]);
    const deleteIndex = messages.findIndex(
      (item) => item.type === 'conversation.item.delete',
    );
    const createIndex = messages.findIndex(
      (item) => item.type === 'conversation.item.create',
    );
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(messages[deleteIndex].item_id).toBe('item_user_1');
    expect(deleteIndex).toBeLessThan(createIndex);
  });

  it('can speak first in a fresh Audio session by creating a read-only input before response.create', async () => {
    const { provider } = setup('qwen-audio-3.0-realtime-plus');
    const connected = provider.connect();
    sockets[0].ready();
    await connected;
    provider.speak('这是一张封面，暂时不能确认作品名称。');
    const messages = sent(sockets[0]);
    const index = messages.findIndex(
      (item) => item.type === 'conversation.item.create',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(messages[index].item).toMatchObject({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: expect.stringContaining('逐字完整朗读') },
      ],
    });
    expect(messages[index + 1].type).toBe('response.create');
  });
  it('does not execute tools requested while only reading a proactive reminder', async () => {
    const { provider, callbacks } = setup('qwen-audio-3.0-realtime-plus');
    const connected = provider.connect();
    sockets[0].ready();
    await connected;
    provider.speak('需要播放它吗？');
    receive(sockets[0], {
      type: 'response.function_call_arguments.done',
      name: 'start_gui_task',
      call_id: 'unexpected',
      arguments: '{"instruction":"play"}',
    });
    expect(callbacks.onToolCall).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('只读播报') }),
    );
  });
  it('queues a confirmed contextual request until cancellation finishes', async () => {
    const { provider } = setup('qwen-audio-3.0-realtime-plus');
    const connected = provider.connect();
    sockets[0].ready();
    await connected;
    provider.cancelResponse();
    expect(provider.submitText('请查证 Day One 的封面背景')).toBe(true);
    expect(
      sent(sockets[0]).some((item) => item.type === 'conversation.item.create'),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(401);
    const user = sent(sockets[0]).find(
      (item) => item.type === 'conversation.item.create',
    );
    expect(user.item.role).toBe('user');
    expect(user.item.content[0].text).toContain('封面背景');
    expect(sent(sockets[0]).at(-1).type).toBe('response.create');
  });
  it('cleans up a gaze reminder and accepts tools again for the next user turn', async () => {
    const { provider, callbacks } = setup('qwen-audio-3.0-realtime-plus');
    const connected = provider.connect();
    sockets[0].ready();
    await connected;
    provider.speak('播放它，还是核实作品信息？');
    expect(
      sent(sockets[0]).filter((m) => m.type === 'conversation.item.create'),
    ).toHaveLength(1);
    receive(sockets[0], {
      type: 'conversation.item.created',
      item: { id: 'gaze-prompt', role: 'user' },
    });
    receive(sockets[0], {
      type: 'response.done',
      response: { status: 'completed' },
    });
    expect(
      sent(sockets[0]).filter(
        (m) =>
          m.type === 'conversation.item.delete' && m.item_id === 'gaze-prompt',
      ),
    ).toHaveLength(1);
    receive(sockets[0], { type: 'input_audio_buffer.speech_started' });
    receive(sockets[0], {
      type: 'response.function_call_arguments.done',
      name: 'start_gui_task',
      call_id: 'confirmed',
      arguments: '{"instruction":"play the selected cover"}',
    });
    expect(callbacks.onToolCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'start_gui_task', callId: 'confirmed' }),
    );
  });

  it('uses a partial instruction update for confirmed requests on Omni', async () => {
    const { provider } = setup('qwen3.8-omni-flash-realtime');
    const connected = provider.connect();
    sockets[0].ready();
    await connected;
    provider.submitText('请介绍刚才确认的作品');
    const update = sent(sockets[0]).find(
      (item) =>
        item.type === 'session.update' &&
        item.session.instructions?.includes('用户已明确选择'),
    );
    expect(update.session.instructions).toContain('用户已明确选择');
    expect(update.session.turn_detection).toBeUndefined();
    expect(sent(sockets[0]).at(-1).type).toBe('response.create');
  });
  it('uses the flat PCM handshake for existing Token Plan configurations', async () => {
    const { provider } = setup(
      'qwen-audio-3.0-realtime-plus',
      'wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus',
    );
    const connecting = provider.connect();
    sockets[0].readyState = 1;
    receive(sockets[0], { type: 'session.created' });
    const payload = sent(sockets[0])[0];
    expect(payload.session.input_audio_format).toBe('pcm');
    expect(payload.session.output_audio_format).toBe('pcm');
    expect(payload.session.audio).toBeUndefined();
    expect(
      payload.session.tools.some(
        (tool: QwenToolDefinition) =>
          tool.function.name === 'inspect_gaze_target',
      ),
    ).toBe(true);
    sockets[0].ready();
    await connecting;
  });
  it('uses the compatible voice field for the configured Qwen3.5 model', async () => {
    const { provider } = setup('qwen3.5-omni-plus-realtime');
    provider.setVoice('Evan');
    const connected = provider.connect();
    sockets[0].readyState = 1;
    receive(sockets[0], { type: 'session.created' });
    expect(sent(sockets[0])[0].session.voice).toBe('Evan');
    expect(sent(sockets[0])[0].session.audio.output.voice).toBeUndefined();
    sockets[0].ready();
    await connected;
    provider.setVoice('Raymond');
    expect(sent(sockets[0]).at(-1).session).toEqual({ voice: 'Raymond' });
  });
  it('uses a selected voice on first connection and after reconnecting', async () => {
    const { provider } = setup();
    provider.setVoice('Evan');
    const connected = provider.connect();
    sockets[0].readyState = 1;
    receive(sockets[0], { type: 'session.created' });
    expect(sent(sockets[0])[0].session.audio.output.voice).toBe('Evan');
    sockets[0].ready();
    await connected;
    provider.close();
    const reconnected = provider.connect();
    sockets[1].readyState = 1;
    receive(sockets[1], { type: 'session.created' });
    expect(sent(sockets[1])[0].session.audio.output.voice).toBe('Evan');
    sockets[1].ready();
    await reconnected;
  });

  it('switches on the same session, drops old audio and plays the next response', async () => {
    const { provider, callbacks } = setup();
    const connected = provider.connect();
    sockets[0].ready();
    await connected;
    receive(sockets[0], { type: 'response.created', response_id: 'old' });
    const audio = { type: 'response.audio.delta', delta: 'AQACAA==' };
    receive(sockets[0], audio);
    expect(callbacks.onAudio).toHaveBeenCalledTimes(1);
    expect(provider.setVoice('Raymond')).toBe(true);
    const events = sent(sockets[0]);
    expect(events.map((event) => event.type)).toContain('response.cancel');
    expect(events.at(-1).session).toEqual({
      audio: { output: { voice: 'Raymond' } },
    });
    receive(sockets[0], audio);
    expect(callbacks.onAudio).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(401);
    receive(sockets[0], { type: 'response.created', response_id: 'new' });
    receive(sockets[0], audio);
    expect(callbacks.onAudio).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].close).not.toHaveBeenCalled();
    const count = sockets[0].send.mock.calls.length;
    expect(provider.setVoice('Raymond')).toBe(false);
    expect(sockets[0].send).toHaveBeenCalledTimes(count);
  });

  it('keeps the last selection when skins change during the connection handshake', async () => {
    const { provider } = setup();
    const connected = provider.connect();
    sockets[0].readyState = 1;
    receive(sockets[0], { type: 'session.created' });
    provider.setVoice('Evan');
    provider.setVoice('Raymond');
    sockets[0].ready();
    await connected;
    expect(sent(sockets[0]).at(-1).session.audio.output.voice).toBe('Raymond');
    expect(sockets).toHaveLength(1);
  });

  it('reports a rejected voice update even while the old response is being canceled', async () => {
    const { provider, callbacks } = setup();
    const connected = provider.connect();
    sockets[0].ready();
    await connected;
    provider.setVoice('Raymond');
    const update = sent(sockets[0]).at(-1);
    receive(sockets[0], {
      type: 'error',
      error: { event_id: update.event_id, message: 'Unsupported voice' },
    });
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Unsupported voice'),
      }),
    );
  });
});

describe('QwenOmniProvider connection lifecycle', () => {
  it('keeps the handshake alive when startup requests overlap', async () => {
    const { provider, callbacks } = setup();
    const first = provider.connect();
    const second = provider.connect();
    // Exercise the same delayed error that escapes the old close() try/catch.
    expect(() => {
      sockets
        .filter((socket) => socket.abortPending)
        .forEach((socket) => socket.flushClose());
    }).not.toThrow();
    expect(sockets).toHaveLength(1);
    sockets[0].ready();
    await Promise.all([first, second]);
    expect(callbacks.onReady).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets[0].close).not.toHaveBeenCalled();
  });

  it('settles a canceled handshake and ignores its late events after restarting', async () => {
    const { provider, callbacks } = setup();
    const outcome = provider.connect().then(
      () => 'ready',
      (error: Error) => error.message,
    );
    const oldSocket = sockets[0];
    provider.close();
    const next = provider.connect();
    expect(() => oldSocket.flushClose()).not.toThrow();
    oldSocket.ready();
    expect(callbacks.onReady).not.toHaveBeenCalled();
    sockets[1].ready();
    await next;
    expect(await outcome).toBe('Qwen realtime connection closed');
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
  });

  it('rejects all startup callers on timeout without leaking a socket error', async () => {
    const { provider, callbacks } = setup();
    const outcomes = [provider.connect(), provider.connect()].map((promise) =>
      promise.then(
        () => 'ready',
        (error: Error) => error.message,
      ),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(() =>
      sockets.forEach((socket) => socket.flushClose()),
    ).not.toThrow();
    expect(await Promise.all(outcomes)).toEqual([
      'Qwen realtime connection timed out',
      'Qwen realtime connection timed out',
    ]);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('retries a failed connection without letting the old socket affect the replacement', async () => {
    const { provider, callbacks } = setup();
    const failure = new Error('connection failed');
    const failed = provider.connect().catch((error) => error);
    const oldSocket = sockets[0];
    oldSocket.emit('error', failure);
    expect(await failed).toBe(failure);
    expect(callbacks.onError).toHaveBeenCalledWith(failure);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    expect(() => oldSocket.flushClose()).not.toThrow();
    sockets[1].ready();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    expect(callbacks.onReady).toHaveBeenCalledTimes(1);
  });

  it('speaks a proactive line through a temporary user item', async () => {
    const { provider } = setup();
    const connected = provider.connect();
    sockets[0].readyState = 1;
    receive(sockets[0], { type: 'session.created' });
    sockets[0].ready();
    await connected;

    provider.speak('编码任务完成');
    const messages = sent(sockets[0]);
    const item = messages.find(
      (message) => message.type === 'conversation.item.create',
    );
    expect(item?.item?.role).toBe('user');
    expect(item?.item?.content?.[0]?.text).toContain('编码任务完成');
    expect(messages.some((message) => message.type === 'response.create')).toBe(
      true,
    );

    receive(sockets[0], {
      type: 'conversation.item.created',
      item: { id: 'item_proactive', role: 'user' },
    });
    receive(sockets[0], {
      type: 'response.done',
      response: { status: 'completed' },
    });

    expect(
      sent(sockets[0]).some(
        (message) =>
          message.type === 'conversation.item.delete' &&
          message.item_id === 'item_proactive',
      ),
    ).toBe(true);
  });
});

describe('QwenOmniProvider tool surface', () => {
  it('queues a session update when the dynamic tool list changes', () => {
    const provider = new QwenOmniProvider({
      apiKey: 'test-key',
      callbacks: {},
    });
    const send = vi.fn();
    const internals = provider as unknown as {
      connected: boolean;
      ws: { readyState: number; send: ReturnType<typeof vi.fn> };
    };
    internals.connected = true;
    internals.ws = { readyState: WebSocket.OPEN, send };
    const tools: QwenToolDefinition[] = [
      {
        type: 'function',
        function: {
          name: 'cyrvis_capability_search',
          description: 'Search capabilities.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      },
    ];

    provider.setTools?.(tools);

    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(send.mock.calls[0]?.[0])) as {
      type: string;
      session: { tools: QwenToolDefinition[] };
    };
    expect(payload.type).toBe('session.update');
    expect(payload.session.tools).toEqual(tools);

    provider.setTools?.(tools);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reverts rejected dynamic tools before reconnecting', () => {
    const provider = new QwenOmniProvider({
      apiKey: 'test-key',
      callbacks: {},
    });
    const send = vi.fn();
    const close = vi.fn();
    const internals = provider as unknown as {
      connected: boolean;
      ws: {
        readyState: number;
        send: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      };
      tools: QwenToolDefinition[];
      lastAcceptedTools: QwenToolDefinition[];
      handleMessage(raw: Buffer): void;
    };
    const acceptedNames = internals.tools.map((tool) => tool.function.name);
    internals.connected = true;
    internals.ws = {
      readyState: WebSocket.OPEN,
      send,
      close,
    };
    provider.setTools?.([
      {
        type: 'function',
        function: {
          name: 'cyrvis_incompatible',
          description: 'Incompatible tool.',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
    ]);
    const event = Buffer.from(
      JSON.stringify({
        type: 'error',
        error: { message: 'invalid tool schema in session.update' },
      }),
    );

    internals.handleMessage(event);
    internals.handleMessage(event);

    expect(internals.tools.map((tool) => tool.function.name)).toEqual(
      acceptedNames,
    );
    expect(close).toHaveBeenCalled();
    provider.close();
  });
});
