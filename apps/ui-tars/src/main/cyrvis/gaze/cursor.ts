import { app, BrowserWindow, screen } from 'electron';
import type { ObjectFixation } from './objects';
import { assistantCaptureActive } from '@main/window/capture';

const SIZE = 36;
export const CURSOR_STALE_MS = 800;
export function cursorPosition(
  x: number,
  y: number,
  bounds: { x: number; y: number; width: number; height: number },
) {
  return {
    x: Math.round(
      bounds.x + Math.max(0, Math.min(1, x)) * (bounds.width - SIZE),
    ),
    y: Math.round(
      bounds.y + Math.max(0, Math.min(1, y)) * (bounds.height - SIZE),
    ),
  };
}

/** A separate, non-activating native window; never takes focus or mouse input. */
export class DesktopGazeCursor {
  private window: BrowserWindow | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;
  private lastSampleAt = 0;
  private enabled = true;
  private position = { x: 0, y: 0 };
  private target: ObjectFixation | null = null;
  private paintKey = '';
  private suspended = 0;

  constructor() {
    app.once('before-quit', () => this.destroy());
  }

  update(
    sample: { x: number; y: number; timestamp: number } | null,
    visibleMs = CURSOR_STALE_MS,
  ) {
    if (
      !sample ||
      !Number.isFinite(sample.x) ||
      !Number.isFinite(sample.y) ||
      !Number.isFinite(sample.timestamp) ||
      sample.x < 0 ||
      sample.x > 1 ||
      sample.y < 0 ||
      sample.y > 1 ||
      Math.abs(Date.now() - sample.timestamp) > CURSOR_STALE_MS
    ) {
      this.hide();
      return;
    }
    this.lastSampleAt = Date.now();
    this.target = null;
    this.position = cursorPosition(
      sample.x,
      sample.y,
      screen.getPrimaryDisplay().bounds,
    );
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.hide(), visibleMs);
    if (!this.enabled) return;
    this.ensureWindow();
    if (this.loaded && this.window && !this.window.isDestroyed()) {
      this.window.setSize(SIZE, SIZE, false);
      this.window.setPosition(this.position.x, this.position.y, false);
      this.paint();
      if (
        !this.suspended &&
        !assistantCaptureActive() &&
        !this.window.isVisible()
      )
        this.window.showInactive();
    }
  }

  updateTarget(state: ObjectFixation | null) {
    if (!state?.target) {
      this.hide();
      return;
    }
    this.target = state;
    this.lastSampleAt = Date.now();
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.hide(), CURSOR_STALE_MS);
    if (!this.enabled) return;
    this.ensureWindow();
    if (this.loaded) {
      this.placeTarget();
      this.paint();
      if (
        !this.suspended &&
        !assistantCaptureActive() &&
        !this.window?.isVisible()
      )
        this.window?.showInactive();
    }
  }

  async withHiddenOverlay<T>(capture: () => Promise<T>): Promise<T> {
    this.suspended++;
    this.window?.hide();
    try {
      // Let the compositor remove the highlight before local image detection.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return await capture();
    } finally {
      this.suspended--;
      if (
        !this.suspended &&
        !assistantCaptureActive() &&
        this.enabled &&
        this.loaded &&
        this.lastSampleAt &&
        Date.now() - this.lastSampleAt < CURSOR_STALE_MS
      )
        this.window?.showInactive();
    }
  }

  private placeTarget() {
    if (!this.target?.target || !this.window) return;
    const b = this.target.target.bounds,
      screenBounds = screen.getPrimaryDisplay().bounds;
    const x = Math.min(
        screenBounds.x + screenBounds.width - 12,
        Math.max(screenBounds.x, Math.floor(b.x - 5)),
      ),
      y = Math.min(
        screenBounds.y + screenBounds.height - 12,
        Math.max(screenBounds.y, Math.floor(b.y - 28)),
      );
    this.window.setBounds(
      {
        x,
        y,
        width: Math.max(
          12,
          Math.min(
            Math.ceil(b.width + 10),
            screenBounds.x + screenBounds.width - x,
          ),
        ),
        height: Math.max(
          12,
          Math.min(
            Math.ceil(b.height + 34),
            screenBounds.y + screenBounds.height - y,
          ),
        ),
      },
      false,
    );
  }

  private paint() {
    if (!this.window || !this.loaded) return;
    const data = this.target?.target
      ? {
          mode: this.target.phase,
          label: `${this.target.phase === 'locked' ? '已锁定' : '候选'} · ${this.target.target.label}`,
          progress: Math.round(this.target.progress * 10) / 10,
        }
      : { mode: 'point', label: '', progress: 0 };
    const key = JSON.stringify(data);
    if (this.paintKey === key) return;
    this.paintKey = key;
    void this.window.webContents
      .executeJavaScript(
        `(()=>{const d=${key};document.body.className=d.mode;document.getElementById('label').textContent=d.label;document.getElementById('progress').style.width=(d.progress*100)+'%';})()`,
      )
      .catch(() => {});
  }

  isVisible() {
    return (
      !!this.window && !this.window.isDestroyed() && this.window.isVisible()
    );
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.hide();
    return enabled;
  }
  toggle() {
    return this.setEnabled(!this.enabled);
  }

  hide() {
    this.lastSampleAt = 0;
    this.target = null;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  destroy() {
    this.hide();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.loaded = false;
    this.paintKey = '';
  }

  private ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return;
    this.loaded = false;
    this.paintKey = '';
    const win = new BrowserWindow({
      title: 'CYRVIS Gaze Cursor',
      width: SIZE,
      height: SIZE,
      x: this.position.x,
      y: this.position.y,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      hasShadow: false,
      show: false,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.window = win;
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.once('closed', () => {
      if (this.window === win) {
        this.window = null;
        this.loaded = false;
      }
    });
    win.webContents.once('did-finish-load', () => {
      if (this.window !== win || win.isDestroyed()) return;
      this.loaded = true;
      if (
        this.enabled &&
        !this.suspended &&
        !assistantCaptureActive() &&
        this.lastSampleAt &&
        Date.now() - this.lastSampleAt < CURSOR_STALE_MS
      ) {
        if (this.target) this.placeTarget();
        else win.setPosition(this.position.x, this.position.y, false);
        this.paint();
        win.showInactive();
      }
    });
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
      html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;pointer-events:none}
      .ring{position:absolute;left:5px;top:5px;width:22px;height:22px;border:3px solid #10d8a0;border-radius:50%;box-shadow:0 0 0 1px #1239,0 0 6px #10d8a060}
      .center{position:absolute;left:16px;top:16px;width:4px;height:4px;border-radius:50%;background:#10d8a0}
      #box,#label{display:none}body.candidate .ring,body.candidate .center,body.locked .ring,body.locked .center{display:none}
      body.candidate,body.locked{--color:#f2b33c}body.locked{--color:#10d8a0}
      body.candidate #box,body.locked #box{display:block;position:absolute;inset:26px 4px 4px;border:3px solid var(--color);border-radius:10px;box-shadow:0 0 0 1px #1239;box-sizing:border-box;background:#10d8a009}
      body.candidate #label,body.locked #label{display:block;position:absolute;left:4px;top:2px;max-width:calc(100% - 8px);box-sizing:border-box;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;padding:3px 7px;border-radius:5px;background:#102c32ed;color:var(--color);font:12px -apple-system,sans-serif}
      #progress{position:absolute;left:0;bottom:0;height:3px;background:var(--color);transition:width .1s linear}
      </style></head><body class="point"><div class="ring"></div><div class="center"></div><div id="label"></div><div id="box"><div id="progress"></div></div></body></html>`;
    void win
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => this.hide());
  }
}
