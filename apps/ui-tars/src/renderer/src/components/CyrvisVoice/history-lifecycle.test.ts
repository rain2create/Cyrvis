// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import type { GazeChatTurn } from '@shared/cyrvis';
import { useVoiceHistory } from './useVoiceHistory';

const db = vi.hoisted(() => ({
  sessions: new Map<string, any>(),
  rows: new Map<string, any[]>(),
  create: vi.fn(async (name: string, meta: unknown) => {
    const value = { id: `session-${db.sessions.size + 1}`, name, meta };
    db.sessions.set(value.id, value);
    return value;
  }),
}));
vi.mock('@renderer/hooks/useStore', () => ({
  getState: () => ({ messages: [] }),
}));
vi.mock('@renderer/db/session', () => ({
  sessionManager: {
    createSession: db.create,
    getSession: async (id: string) => db.sessions.get(id),
    updateSession: vi.fn(async () => {}),
  },
}));
vi.mock('@renderer/db/chat', () => ({
  chatManager: {
    getSessionMessages: async (id: string) => db.rows.get(id),
    updateSessionMessages: async (id: string, rows: any[]) => {
      db.rows.set(id, rows);
    },
  },
}));

let root: Root | undefined;
let routeTo: ReturnType<typeof useNavigate>;
const events = new Map<string, Set<(value?: any) => void>>();
let recent: GazeChatTurn[] = [];
let voice: any;
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const emit = (event: string, value?: any) =>
  events.get(event)?.forEach((listener) => listener(value));
const shot = (id = 'shot-a'): GazeChatTurn => ({
  id,
  trigger: 'proactive',
  phase: 'recognized',
  question: '我正在注视的区域',
  preview: 'data:image/jpeg;base64,dGVzdA==',
  answer: '测试封面',
  createdAt: 1,
  updatedAt: 1,
});
function Harness() {
  useVoiceHistory();
  routeTo = useNavigate();
  return React.createElement('p', null, useLocation().pathname);
}
async function mount() {
  const node = document.createElement('div');
  document.body.appendChild(node);
  root = createRoot(node);
  await act(async () => {
    root!.render(
      React.createElement(MemoryRouter, null, React.createElement(Harness)),
    );
    await flush();
  });
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  db.sessions.clear();
  db.rows.clear();
  db.create.mockClear();
  events.clear();
  recent = [];
  sessionStorage.clear();
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      postMessage() {}
      close() {}
    },
  );
  voice = { getGazeTurns: vi.fn(async () => recent) };
  for (const event of [
    'onGazeTurn',
    'onTranscript',
    'onAssistantText',
    'onSleep',
    'onTaskEvent',
  ]) {
    voice[event] = vi.fn((listener: (value?: any) => void) => {
      const listeners = events.get(event) || new Set();
      listeners.add(listener);
      events.set(event, listeners);
      return () => listeners.delete(listener);
    });
  }
  (window as any).electron = { voice };
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flush();
  });
  root = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it('keeps one collector and one chat across gaze navigation, idle sleep, and further user requests', async () => {
  await mount();
  recent = [shot()];
  await act(async () => {
    emit('onGazeTurn', shot());
    await flush();
  });
  expect(db.create).toHaveBeenCalledOnce();
  await act(async () => {
    routeTo('/local');
    await flush();
  });
  await act(async () => {
    emit('onSleep');
    emit('onGazeTurn', { ...shot(), phase: 'spoken' });
    emit('onTranscript', { text: '打开微信', final: true });
    emit('onGazeTurn', shot('shot-b'));
    await flush();
  });
  expect(voice.onGazeTurn).toHaveBeenCalledOnce();
  expect(voice.getGazeTurns).toHaveBeenCalledOnce();
  expect(db.create).toHaveBeenCalledOnce();
  expect(
    db.rows.get('session-1')?.map((row) => row.gazeTurn?.id || row.value),
  ).toEqual(['shot-a', '打开微信', 'shot-b']);
});

it('upserts the same screenshot after a renderer remount and creates a chat only on explicit New chat', async () => {
  await mount();
  recent = [shot()];
  await act(async () => {
    emit('onGazeTurn', shot());
    await flush();
  });
  await act(async () => {
    root!.unmount();
    await flush();
  });
  root = undefined;
  await mount();
  expect(db.create).toHaveBeenCalledOnce();
  expect(db.rows.get('session-1')).toHaveLength(1);
  await act(async () => {
    window.dispatchEvent(new Event('cyrvis:new-chat'));
    emit('onTranscript', { text: '新的任务', final: true });
    await flush();
  });
  expect(db.create).toHaveBeenCalledTimes(2);
  expect(db.rows.get('session-2')?.[0].value).toBe('新的任务');
});
