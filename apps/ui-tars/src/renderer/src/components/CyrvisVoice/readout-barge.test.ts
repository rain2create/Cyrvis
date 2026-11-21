// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useVoiceAudio } from './useVoiceAudio';

vi.mock('@renderer/hooks/useSetting', () => ({
  useSetting: () => ({ settings: { voiceEngine: 'omni' } }),
}));
const playback = vi.hoisted(() => ({ stop: vi.fn(), play: vi.fn() }));
vi.mock('./webaudio-player', () => ({
  WebAudioStreamPlayer: class {
    play = playback.play;
    stop = playback.stop;
  },
}));

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
});

it('keeps gaze readout playing through mic energy while feeding stop-word audio and retaining explicit stop', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const events = new Map<string, (...args: any[]) => void>();
  const methods: Record<string, any> = {
    isTestMode: true,
    getPtt: vi.fn(async () => ({ active: false, mode: false })),
    getAudioMode: vi.fn(async () => ({ mode: 'headset' })),
    start: vi.fn(async () => ({ ok: true })),
  };
  const voice = new Proxy(methods, {
    get(target, key: string) {
      if (!(key in target)) {
        target[key] = key.startsWith('on')
          ? (callback: (...args: any[]) => void) => {
              events.set(key, callback);
              return () => events.delete(key);
            }
          : vi.fn();
      }
      return target[key];
    },
  });
  (window as any).electron = { voice };
  const track = {
    label: 'Built-in microphone',
    getSettings: () => ({}),
    stop: vi.fn(),
    addEventListener: vi.fn(),
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getAudioTracks: () => [track],
        getTracks: () => [track],
      })),
      enumerateDevices: vi.fn(async () => []),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  const processors: any[] = [];
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 48_000;
      destination = {};
      resume = async () => {};
      close = async () => {};
      createMediaStreamSource = node;
      createGain = () => ({ ...node(), gain: { value: 0 } });
      createScriptProcessor() {
        const processor = { ...node(), onaudioprocess: null };
        processors.push(processor);
        return processor;
      }
    },
  );
  let audio!: ReturnType<typeof useVoiceAudio>;
  function Harness() {
    audio = useVoiceAudio();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(React.createElement(Harness)));
  await act(async () => audio.start());
  expect(audio.micReady).toBe(true);
  await act(async () => {
    events.get('onState')!({
      awake: true,
      readoutGuardUntil: Date.now() + 45_000,
    });
    events.get('onAudio')!(new Int16Array([10, 20]));
  });
  playback.stop.mockClear();
  const loudMic = {
    inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.2) },
  };
  await act(async () => {
    for (let i = 0; i < 5; i++) processors[0].onaudioprocess(loudMic);
    processors[1].onaudioprocess(loudMic); // Dedicated KWS capture stays live.
  });
  expect(voice.cancelSpeechOnly).not.toHaveBeenCalled();
  expect(playback.stop).not.toHaveBeenCalled();
  expect(voice.sendKeywordAudio).toHaveBeenCalled();
  await act(async () => audio.interrupt());
  expect(voice.bargeIn).toHaveBeenCalledOnce();
  expect(playback.stop).toHaveBeenCalledOnce();
  await act(async () => {
    events.get('onState')!({ awake: true, readoutGuardUntil: 0 });
    events.get('onAudio')!(new Int16Array([10, 20]));
    for (let i = 0; i < 5; i++) processors[0].onaudioprocess(loudMic);
  });
  expect(voice.cancelSpeechOnly).toHaveBeenCalledOnce();
});
