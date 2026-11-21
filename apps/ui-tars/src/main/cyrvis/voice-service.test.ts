import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { CaptureServiceHandlers } from './capture-service';
import type { VoiceProviderCallbacks } from './voice/provider';
import type { QwenOmniConfig } from './voice/qwen-omni';

type IpcCallback = (...args: unknown[]) => unknown;

const mock = vi.hoisted(() => ({
  handlers: new Map<string, IpcCallback>(),
  events: new Map<string, IpcCallback>(),
  capture: null as CaptureServiceHandlers | null,
  callbacks: null as VoiceProviderCallbacks | null,
  config: null as QwenOmniConfig | null,
  skinId: undefined as string | undefined,
  skinListeners: new Set<(value: string | undefined) => void>(),
  send: vi.fn(),
  wake: vi.fn(),
  speakReply: vi.fn(),
  offerSuggestion: vi.fn(),
  readoutActive: false,
  objectScan: vi.fn(async () => ({ scene: 'test', objects: [] as any[] })),
  cursorPoint: vi.fn(),
  cursorTarget: vi.fn(),
  start: vi.fn(async () => undefined),
  captureClose: vi.fn(),
  provider: {
    sendAudio: vi.fn(),
    bargeIn: vi.fn(),
    clearAudioBuffer: vi.fn(),
    notifyPlaybackIdle: vi.fn(),
    setVoice: vi.fn(() => true),
  },
}));
vi.mock('electron', () => ({
  app: { on: vi.fn(), once: vi.fn() },
  screen: {
    on: vi.fn(),
    getPrimaryDisplay: () => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    }),
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: mock.send } },
    ],
  },
  globalShortcut: { register: () => true },
  ipcMain: {
    handle: (name: string, fn: IpcCallback) => mock.handlers.set(name, fn),
    on: (name: string, fn: IpcCallback) => mock.events.set(name, fn),
  },
}));
vi.mock('electron-store', () => ({
  default: class {
    get() {
      return mock.skinId;
    }
    set(_key: string, value: string) {
      if (mock.skinId === value) return;
      mock.skinId = value;
      for (const listener of mock.skinListeners) listener(value);
    }
    onDidChange(_key: string, listener: (value: string | undefined) => void) {
      mock.skinListeners.add(listener);
      return () => mock.skinListeners.delete(listener);
    }
  },
}));
vi.mock('@main/env', () => ({
  isDev: false,
  voiceEngine: 'omni',
  voiceSilenceTimeoutMs: 600,
}));
vi.mock('@main/store/setting', () => ({
  SettingStore: { getStore: () => ({ voiceEngine: 'omni' }) },
}));
vi.mock('@main/services/breezeTts', () => ({
  breezeTtsService: { stop: vi.fn() },
}));
vi.mock('@main/services/qwenTtsRealtime', () => ({
  qwenTtsRealtimeService: { stopAll: vi.fn() },
}));
vi.mock('./voice/local-tts', () => ({ localTtsService: {} }));
vi.mock('./voice/cascade-provider', () => ({ CascadeVoiceProvider: class {} }));
vi.mock('./keyword-gate', () => ({
  KeywordGate: class {
    load() {}
    reset() {}
  },
}));
vi.mock('./memory', () => ({
  voiceMemoryService: {
    appendActivity: vi.fn(async () => undefined),
    getSnapshot: () => ({ turns: [] }),
  },
}));
vi.mock('@main/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@main/window', () => ({ showCompanion: vi.fn() }));
vi.mock('./gaze/native-objects', () => ({
  NativeGazeObjects: class {
    scan = mock.objectScan;
  },
}));
vi.mock('./gaze/cursor', () => ({
  DesktopGazeCursor: class {
    update = mock.cursorPoint;
    updateTarget = mock.cursorTarget;
    hide = vi.fn();
    setEnabled = vi.fn();
    toggle = vi.fn();
    isVisible = () => true;
    withHiddenOverlay = <T>(capture: () => Promise<T>) => capture();
  },
}));
vi.mock('./capture-service', () => ({
  startCaptureService: async (callbacks: CaptureServiceHandlers) => {
    mock.capture = callbacks;
    callbacks.onReady('Built-in microphone');
    return { close: mock.captureClose };
  },
}));
vi.mock('./controller', () => ({
  CyrvisController: class {
    isBusy = () => false;
  },
}));
vi.mock('./gui-adapter', () => ({ ElectronGUIAdapter: class {} }));
vi.mock('./voice/qwen-omni', () => ({
  QwenOmniProvider: class {
    constructor(config: QwenOmniConfig) {
      mock.config = config;
      mock.callbacks = config.callbacks;
      Object.assign(this, mock.provider);
    }
  },
}));
vi.mock('./voice-brain', () => ({
  VoiceBrain: class {
    constructor(
      _controller: unknown,
      _callbacks: unknown,
      factory: (callbacks: VoiceProviderCallbacks) => unknown,
    ) {
      factory({});
    }
    forceAwake = mock.wake;
    speakRequestedReply = mock.speakReply;
    clearGazeSuggestion = vi.fn();
    isReadoutSpeechActive = () => mock.readoutActive;
    handleBargeStop = vi.fn();
    isGazeFollowup = () => false;
    canOfferGazeSuggestion = () => true;
    gazeSuggestionBlockReason = () => undefined;
    offerGazeSuggestion = mock.offerSuggestion;
    start = mock.start;
    sleep = vi.fn();
    shouldSuppressReply = () => false;
    getState() {
      return {};
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.skinId = undefined;
  mock.capture = null;
  mock.readoutActive = false;
  mock.offerSuggestion.mockReturnValue(true);
  mock.objectScan.mockResolvedValue({ scene: 'test', objects: [] });
  mock.skinListeners.clear();
  vi.useFakeTimers();
  vi.stubEnv('QWEN_API_KEY', 'test');
  vi.stubEnv('CYRVIS_VOICE_TEST', '1');
});

it('starts with the saved companion voice instead of the default', async () => {
  mock.skinId = 'jarvis';
  const { startVoiceService } = await import('./voice-service');
  startVoiceService();
  expect(mock.config!.voice).toBe('Raymond');
});

it('rejects energy-only interruption of gaze readout and defers historical greeting speech', async () => {
  const { startVoiceService, shouldDeferFollowUpSpeech } = await import(
    './voice-service'
  );
  startVoiceService();
  mock.readoutActive = true;
  mock.events.get('cyrvis:voice:cancel-speech-only')!();
  expect(mock.provider.bargeIn).not.toHaveBeenCalled();
  expect(shouldDeferFollowUpSpeech()).toBe(true);
});

it('routes a gaze-button answer through the brain so sleeping voice can speak it', async () => {
  const { startVoiceService } = await import('./voice-service');
  const { gazeInspector } = await import('./gaze/desktop-inspector');
  startVoiceService();
  const inspect = vi
    .spyOn(gazeInspector, 'inspect')
    .mockResolvedValue('看屏结果');
  await mock.handlers.get('cyrvis:gaze:inspect')!();
  expect(mock.speakReply).toHaveBeenCalledWith('看屏结果');
  inspect.mockRestore();
});

it('prefers QWEN_VOICE over companion skins when configured', async () => {
  vi.stubEnv('QWEN_VOICE', 'longanqian');
  mock.skinId = 'jarvis';
  const { startVoiceService } = await import('./voice-service');
  const { getCompanionStore } = await import('../store/companion');
  startVoiceService();
  expect(mock.config!.voice).toBe('longanqian');
  getCompanionStore().set('skinId', 'awesome-agumon--legeling');
  expect(mock.provider.setVoice).not.toHaveBeenCalled();
});

it('turns sustained desktop gaze into one voice suggestion only after opt-in', async () => {
  const { startVoiceService } = await import('./voice-service');
  const { gazeInspector } = await import('./gaze/desktop-inspector');
  const { parseGazeSuggestion } = await import('./gaze/suggestions');
  startVoiceService();
  await mock.handlers.get('cyrvis:voice:start')!();
  mock.handlers.get('cyrvis:gaze:object-configure')!(undefined, false);
  mock.events.get('cyrvis:voice:renderer-capture-ready')!(
    undefined,
    'Built-in microphone',
  );
  mock.handlers.get('cyrvis:gaze:inspect-enabled')!(undefined, true);
  const suggestion = parseGazeSuggestion(
    '{"kind":"music","target":"Day One","description":"你似乎在看 Day One 的封面","identified":true,"confidence":"high"}',
    Date.now(),
  )!;
  const suggest = vi
    .spyOn(gazeInspector, 'suggest')
    .mockResolvedValue(suggestion);
  const sample = () =>
    mock.handlers.get('cyrvis:gaze:update')!(undefined, {
      x: 0.5,
      y: 0.5,
      timestamp: Date.now(),
    });
  for (let i = 0; i < 12; i++) {
    sample();
    await vi.advanceTimersByTimeAsync(500);
  }
  expect(suggest).not.toHaveBeenCalled();
  mock.handlers.get('cyrvis:gaze:proactive-configure')!(undefined, {
    enabled: true,
  });
  for (let i = 0; i < 12; i++) {
    sample();
    await vi.advanceTimersByTimeAsync(500);
  }
  expect(suggest).toHaveBeenCalledOnce();
  expect(mock.offerSuggestion).toHaveBeenCalledWith(
    expect.objectContaining({
      target: 'Day One',
      gaze: expect.objectContaining({ x: 0.5 }),
    }),
  );
  mock.handlers.get('cyrvis:gaze:inspect-enabled')!(undefined, false);
  expect(mock.handlers.get('cyrvis:gaze:proactive-status')!()).toMatchObject({
    enabled: false,
  });
  suggest.mockRestore();
});

it('switches voice from the shared appearance selection and clears old playback without starting capture', async () => {
  const { startVoiceService } = await import('./voice-service');
  const { getCompanionStore } = await import('../store/companion');
  startVoiceService();
  mock.callbacks!.onResponseStarted!();
  getCompanionStore().set('skinId', 'awesome-agumon--legeling');
  expect(mock.provider.setVoice).toHaveBeenLastCalledWith('Evan');
  expect(mock.send).toHaveBeenCalledWith(
    'cyrvis:voice:response-stopped',
    undefined,
  );
  expect(mock.send).not.toHaveBeenCalledWith(
    'cyrvis:voice:capture-ready',
    expect.anything(),
  );
  const count = mock.provider.setVoice.mock.calls.length;
  getCompanionStore().set('skinId', 'awesome-agumon--legeling');
  expect(mock.provider.setVoice).toHaveBeenCalledTimes(count);
  getCompanionStore().set('skinId', 'starpie-stocking');
  expect(mock.provider.setVoice).toHaveBeenLastCalledWith('Katerina');
  getCompanionStore().set('skinId', 'removed');
  expect(mock.provider.setVoice).toHaveBeenLastCalledWith('Tina');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it('uses renderer-owned capture without starting a second microphone', async () => {
  const { startVoiceService } = await import('./voice-service');
  startVoiceService();
  const result = await mock.handlers.get('cyrvis:voice:start')!();
  expect(result).toMatchObject({ ok: true });
  expect(mock.capture).toBeNull();
  mock.events.get('cyrvis:voice:renderer-capture-ready')!(
    undefined,
    'Built-in microphone',
  );
  expect(mock.handlers.get('cyrvis:voice:get-capture-ready')!()).toEqual({
    ready: true,
  });
  mock.handlers.get('cyrvis:voice:stop')!();
  expect(mock.handlers.get('cyrvis:voice:get-capture-ready')!()).toEqual({
    ready: false,
  });
});

it('feeds locked object context into proactive recognition instead of raw jitter', async () => {
  const { startVoiceService } = await import('./voice-service');
  const { gazeInspector } = await import('./gaze/desktop-inspector');
  const { getDesktopGaze } = await import('./gaze/context');
  startVoiceService();
  await mock.handlers.get('cyrvis:voice:start')!();
  mock.events.get('cyrvis:voice:renderer-capture-ready')!(
    undefined,
    'Built-in microphone',
  );
  mock.handlers.get('cyrvis:gaze:inspect-enabled')!(undefined, true);
  mock.handlers.get('cyrvis:gaze:proactive-configure')!(undefined, {
    enabled: true,
  });
  mock.objectScan.mockResolvedValue({
    scene: 'test',
    objects: [
      {
        id: 'cover',
        scene: 'test',
        label: '测试封面',
        role: 'AXImage',
        source: 'accessibility',
        bounds: { x: 630, y: 360, width: 180, height: 180 },
      },
    ],
  });
  const suggest = vi.spyOn(gazeInspector, 'suggest').mockResolvedValue(null);
  for (let i = 0; i < 65; i++) {
    mock.handlers.get('cyrvis:gaze:cursor')!(undefined, {
      x: i % 2 ? 0.49 : 0.51,
      y: 0.5,
      timestamp: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(getDesktopGaze()).toMatchObject({
    x: 0.5,
    y: 0.5,
    target: { id: 'cover' },
  });
  expect(mock.cursorPoint).not.toHaveBeenCalled();
  expect(mock.cursorTarget).toHaveBeenLastCalledWith(
    expect.objectContaining({
      phase: 'locked',
      target: expect.objectContaining({ id: 'cover' }),
    }),
  );
  expect(suggest).toHaveBeenCalledOnce();
  mock.handlers.get('cyrvis:gaze:cursor')!(undefined, null);
  expect(getDesktopGaze()).toBeNull();
  suggest.mockRestore();
});

it('shows the free point only when object snapping is explicitly disabled', async () => {
  const { startVoiceService } = await import('./voice-service');
  startVoiceService();
  const sample = () => ({ x: 0.5, y: 0.5, timestamp: Date.now() });
  mock.handlers.get('cyrvis:gaze:cursor')!(undefined, sample());
  await vi.advanceTimersByTimeAsync(50);
  expect(mock.cursorPoint).not.toHaveBeenCalled();
  expect(mock.cursorTarget).toHaveBeenLastCalledWith(null);
  mock.handlers.get('cyrvis:gaze:object-configure')!(undefined, false);
  const raw = sample();
  mock.handlers.get('cyrvis:gaze:cursor')!(undefined, raw);
  expect(mock.cursorPoint).toHaveBeenLastCalledWith(raw);
  mock.handlers.get('cyrvis:gaze:object-configure')!(undefined, true);
  mock.cursorPoint.mockClear();
  mock.handlers.get('cyrvis:gaze:cursor')!(undefined, sample());
  expect(mock.cursorPoint).not.toHaveBeenCalled();
});

it('keeps voice paused when the companion is changed', async () => {
  const { startVoiceService } = await import('./voice-service');
  const { getCompanionStore } = await import('../store/companion');
  startVoiceService();
  await mock.handlers.get('cyrvis:voice:start')!();
  mock.handlers.get('cyrvis:voice:stop')!();
  mock.start.mockClear();
  mock.send.mockClear();
  getCompanionStore().set('skinId', 'jarvis');
  expect(mock.provider.setVoice).toHaveBeenCalledWith('Raymond');
  expect(mock.start).not.toHaveBeenCalled();
  expect(mock.wake).not.toHaveBeenCalled();
  expect(mock.captureClose).not.toHaveBeenCalled();
  expect(mock.send).not.toHaveBeenCalledWith(
    'cyrvis:voice:capture-ready',
    expect.anything(),
  );
});
