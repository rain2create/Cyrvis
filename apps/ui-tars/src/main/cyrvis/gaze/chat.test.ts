import { afterEach, expect, it, vi } from 'vitest';
import { GazeChat } from './chat';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
const observation = (id = 'shot-a') => ({
  id,
  enabled: true,
  phase: 'done' as const,
  createdAt: Date.now(),
  intent: 'manual' as const,
  question: '我在看什么？',
  answer: '这里是一张音乐封面。要播放还是查看信息？',
  preview: 'data:image/jpeg;base64,dGVzdA==',
});

it('keeps screenshot, answer and playback receipts under the same message id', () => {
  const chat = new GazeChat();
  chat.observe(observation());
  for (const phase of [
    'queued',
    'generating',
    'audio',
    'playing',
    'spoken',
  ] as const)
    chat.speech('shot-a', phase);
  expect(chat.recent()).toHaveLength(1);
  expect(chat.get('shot-a')).toMatchObject({
    preview: observation().preview,
    answer: observation().answer,
    phase: 'spoken',
  });
  chat.speech('another-shot', 'failed');
  expect(chat.get('shot-a')?.phase).toBe('spoken');
});

it('does not treat an empty playback queue as proof audio started', () => {
  const chat = new GazeChat();
  chat.observe(observation());
  chat.speech('shot-a', 'audio');
  chat.speech('shot-a', 'spoken');
  expect(chat.get('shot-a')).toMatchObject({
    phase: 'failed',
    error: expect.stringContaining('没有收到播放器启动确认'),
  });
});

it('reports a stalled handoff and allows a deliberate replay, without reviving cancelled audio', async () => {
  vi.useFakeTimers();
  const chat = new GazeChat();
  chat.observe(observation());
  await vi.advanceTimersByTimeAsync(30_001);
  expect(chat.get('shot-a')?.phase).toBe('failed');
  chat.speech('shot-a', 'queued');
  chat.speech('shot-a', 'cancelled');
  chat.speech('shot-a', 'playing');
  expect(chat.get('shot-a')?.phase).toBe('cancelled');
});
