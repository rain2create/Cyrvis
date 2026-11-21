import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  windows: [] as any[],
  bounds: { x: -1440, y: 0, width: 1440, height: 900 },
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    destroyed = false;
    visible = false;
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async () => undefined),
    });
    setIgnoreMouseEvents = vi.fn();
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setPosition = vi.fn();
    setSize = vi.fn();
    setBounds = vi.fn();
    loadURL = vi.fn(() => Promise.resolve());
    showInactive = vi.fn(() => {
      this.visible = true;
    });
    hide = vi.fn(() => {
      this.visible = false;
    });
    destroy = vi.fn(() => {
      this.destroyed = true;
      this.emit('closed');
    });
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    constructor(public options: any) {
      super();
      state.windows.push(this);
    }
  }
  return {
    app: { once: vi.fn() },
    BrowserWindow: Window,
    screen: { getPrimaryDisplay: () => ({ bounds: state.bounds }) },
  };
});
import { CURSOR_STALE_MS, DesktopGazeCursor, cursorPosition } from './cursor';
describe('desktop gaze cursor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.windows = [];
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  const sample = () => ({ x: 0.5, y: 0.5, timestamp: Date.now() });
  it('maps logical desktop coordinates including negative display origins', () => {
    expect(cursorPosition(0.5, 0.5, state.bounds)).toEqual({ x: -738, y: 432 });
    expect(cursorPosition(-1, 2, state.bounds)).toEqual({ x: -1440, y: 864 });
  });
  it('creates a transparent independent click-through window without stealing focus', () => {
    const cursor = new DesktopGazeCursor();
    cursor.update(sample());
    const win = state.windows[0];
    expect(win.options).toMatchObject({
      transparent: true,
      focusable: false,
      frame: false,
      show: false,
      skipTaskbar: true,
    });
    expect(win.options.parent).toBeUndefined();
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
    });
    expect(win.showInactive).not.toHaveBeenCalled();
    win.webContents.emit('did-finish-load');
    expect(win.showInactive).toHaveBeenCalledOnce();
    expect(win.setPosition).toHaveBeenCalledWith(-738, 432, false);
    cursor.destroy();
  });
  it('hides stale tracking and invalid coordinates rather than leaving a false fixation', () => {
    const cursor = new DesktopGazeCursor();
    cursor.update(sample());
    const win = state.windows[0];
    win.webContents.emit('did-finish-load');
    vi.advanceTimersByTime(CURSOR_STALE_MS);
    expect(win.visible).toBe(false);
    cursor.update(sample());
    expect(win.visible).toBe(true);
    cursor.update({ ...sample(), x: NaN });
    expect(win.visible).toBe(false);
    cursor.destroy();
  });
  it('does not revive after cancellation during window loading', () => {
    const cursor = new DesktopGazeCursor();
    cursor.update(sample());
    const win = state.windows[0];
    cursor.hide();
    win.webContents.emit('did-finish-load');
    expect(win.showInactive).not.toHaveBeenCalled();
    cursor.destroy();
  });
  it('respects manual hide and resumes only on a fresh sample', () => {
    const cursor = new DesktopGazeCursor();
    cursor.setEnabled(false);
    cursor.update(sample());
    expect(state.windows).toHaveLength(0);
    cursor.setEnabled(true);
    cursor.update(sample());
    const win = state.windows[0];
    win.webContents.emit('did-finish-load');
    expect(win.visible).toBe(true);
    cursor.toggle();
    expect(win.visible).toBe(false);
    cursor.destroy();
  });
  it('highlights an object without moving the system pointer or exposing click targets', () => {
    const cursor = new DesktopGazeCursor();
    cursor.updateTarget({
      phase: 'locked',
      progress: 1,
      target: {
        id: 'cover',
        scene: 'test',
        label: '音乐封面',
        role: 'AXImage',
        source: 'accessibility',
        bounds: { x: -1000, y: 200, width: 180, height: 180 },
      },
    });
    const win = state.windows[0];
    win.webContents.emit('did-finish-load');
    expect(win.setBounds).toHaveBeenLastCalledWith(
      { x: -1005, y: 172, width: 190, height: 214 },
      false,
    );
    expect(win.webContents.executeJavaScript.mock.calls[0][0]).toContain(
      '已锁定',
    );
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    cursor.destroy();
  });
  it('does not restore a stale highlight after local capture finishes', async () => {
    const cursor = new DesktopGazeCursor();
    cursor.update(sample());
    const win = state.windows[0];
    win.webContents.emit('did-finish-load');
    const capture = cursor.withHiddenOverlay(async () => {
      cursor.hide();
      return 'frame';
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(await capture).toBe('frame');
    expect(win.visible).toBe(false);
    cursor.destroy();
  });
});
