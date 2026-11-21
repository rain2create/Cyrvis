/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CyrvisController } from './controller';
import { createFastToolMatrix } from './tools';
import type {
  DesktopHost,
  DiskInfo,
  ProcessInfo,
  SystemInfo,
  ToolDefinition,
  WindowInfo,
} from './tools';
import type { GUIAdapter, GUIAdapterCallbacks } from './types';
import type {
  VoiceProvider,
  VoiceProviderCallbacks,
  VoiceToolCallWithId,
} from './voice/provider';
import { VoiceBrain } from './voice-brain';
import { parseGazeSuggestion } from './gaze/suggestions';
import { buildVoiceToolSurface } from './voice/tool-surface';
import { buildSearchUrl } from './navigation';
import { buildSiteSearchUrl, resolveSite } from './site-registry';

vi.mock('./desktop-actions', () => ({
  openApp: vi.fn(),
  openUrl: vi.fn(),
  openSearch: vi.fn(),
}));

class NoopGUIAdapter implements GUIAdapter {
  started = false;

  async start(
    _instruction: string,
    callbacks: GUIAdapterCallbacks,
  ): Promise<void> {
    this.started = true;
    callbacks.onStarted();
  }

  async cancel(): Promise<void> {
    return undefined;
  }

  async pause(): Promise<void> {
    return undefined;
  }

  async resume(): Promise<void> {
    return undefined;
  }
}

class FakeProvider implements VoiceProvider {
  readonly spoken: string[] = [];
  readonly toolResults: Array<{ callId: string; output: string }> = [];
  canceled = 0;

  constructor(readonly callbacks: VoiceProviderCallbacks) {}

  async connect(): Promise<void> {
    this.callbacks.onReady?.();
  }

  sendAudio(): void {
    return undefined;
  }

  sendToolResult(callId: string, output: string): void {
    this.toolResults.push({ callId, output });
  }

  cancelResponse(): void {
    this.canceled += 1;
  }

  speak(text: string): void {
    this.spoken.push(text);
    this.callbacks.onResponseStarted?.();
    this.callbacks.onResponseDone?.();
  }

  close(): void {
    return undefined;
  }

  transcript(text: string): boolean | void {
    return this.callbacks.onTranscript?.(text, true);
  }

  toolCall(call: VoiceToolCallWithId): void {
    this.callbacks.onToolCall?.(call);
  }

  assistantText(text: string): void {
    this.callbacks.onAssistantText?.(text, true);
  }

  audio(): void {
    this.callbacks.onAudio?.(new Int16Array([1]));
  }

  responseStarted(): void {
    this.callbacks.onResponseStarted?.();
  }

  responseDone(): void {
    this.callbacks.onResponseDone?.();
  }

  speechText(text: string, final = true): void {
    this.callbacks.onSpeechText?.(text, final);
  }
}

class FakeDesktopHost implements DesktopHost {
  readonly launched: string[] = [];
  readonly closed: string[] = [];
  readonly presentations: string[] = [];
  readonly openedUrls: string[] = [];
  minimizedAll = 0;

  async openPath(): Promise<void> {
    return undefined;
  }

  async openUrl(url: string): Promise<void> {
    this.openedUrls.push(url);
  }

  async clipboardRead(): Promise<string> {
    return '';
  }

  async clipboardWrite(): Promise<void> {
    return undefined;
  }

  async launchApplication(name: string): Promise<string> {
    this.launched.push(name);
    return name;
  }

  async closeApplication(name: string): Promise<string> {
    this.closed.push(name);
    return name;
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    return [];
  }

  async listWindows(): Promise<WindowInfo[]> {
    return [];
  }

  async controlWindow(query: string): Promise<string> {
    return query;
  }

  async minimizeAllWindows(): Promise<number> {
    this.minimizedAll += 1;
    return 4;
  }

  async restoreAllWindows(): Promise<number> {
    return 4;
  }

  async createPresentation(input: {
    path: string;
    title: string;
    subtitle?: string;
  }): Promise<void> {
    this.presentations.push(input.path);
  }

  async systemInfo(): Promise<SystemInfo> {
    return {
      platform: 'test',
      release: '1.0',
      architecture: 'x64',
      hostname: 'test',
      homeDirectory: os.homedir(),
      cpuCount: 1,
      totalMemoryBytes: 1,
      freeMemoryBytes: 1,
      uptimeSeconds: 1,
    };
  }

  async diskInfo(target: string): Promise<DiskInfo> {
    return { path: target, totalBytes: 1, freeBytes: 1 };
  }
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

async function setupNavigation(
  deniedPermissions: Array<'network' | 'desktop.app'> = [],
) {
  const desktop = new FakeDesktopHost();
  const matrix = createFastToolMatrix(desktop, process.cwd(), undefined, {
    deniedPermissions,
  });
  const adapter = new NoopGUIAdapter();
  const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
  let provider!: FakeProvider;
  const brain = new VoiceBrain(
    controller,
    {},
    (callbacks) => {
      provider = new FakeProvider(callbacks);
      return provider;
    },
    { requireWakeWord: false, fastToolRouter: matrix.router },
  );
  await brain.start();
  return {
    desktop,
    matrix,
    provider,
    adapter,
    brain,
    dispose: () => {
      brain.dispose();
      matrix.dispose();
    },
  };
}

describe('unified navigation', () => {
  it('returns a running result immediately and speaks when a slow capability finishes', async () => {
    const x = await setupNavigation();
    let finish!: (value: { ok: true; tool: string; speech: string }) => void;
    const slowTool: ToolDefinition = {
      name: 'test.long-running',
      domain: 'system',
      description: 'Slow test capability.',
      risk: 'medium',
      capability: {
        providerId: 'test',
        tier: 2,
        activation: 'on-demand',
        latencyClass: 'slow',
      },
      contract: {
        timeoutMs: 2 * 60_000,
        verification: 'none',
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      prepare: () => ({}),
      execute: async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    x.matrix.registry.register(slowTool, 'test');
    x.matrix.surface.refresh();

    try {
      x.provider.toolCall({
        callId: 'slow-capability',
        name: 'cyrvis_capability_invoke',
        args: {
          toolId: 'test.long-running',
          arguments: {},
        },
      });
      await flush();
      expect(x.provider.toolResults).toHaveLength(1);
      expect(x.provider.toolResults[0].output).toContain('"status":"running"');
      expect(x.provider.toolResults[0].output).toContain('"background":true');

      finish({
        ok: true,
        tool: 'test.long-running',
        speech: '长任务已经完成。',
      });
      await vi.waitFor(() =>
        expect(x.provider.spoken.join('')).toContain('长任务已经完成'),
      );
    } finally {
      x.dispose();
    }
  });

  it('keeps sensitive-action confirmation ahead of a pending gaze menu', async () => {
    const x = await setupNavigation();
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'cyrvis-gaze-confirm-'),
    );
    const file = path.join(directory, 'delete-me.txt');
    try {
      await fs.writeFile(file, 'temporary test data');
      x.brain.offerGazeSuggestion(
        parseGazeSuggestion(
          JSON.stringify({
            kind: 'music',
            description: '封面',
            confidence: 'high',
            identified: false,
          }),
          Date.now(),
        )!,
      );
      await x.matrix.router.handleText(`删除文件 ${file}`);
      expect(x.matrix.router.hasPendingConfirmation()).toBe(true);
      x.provider.transcript('是的');
      await vi.waitFor(
        async () => {
          await expect(fs.access(file)).rejects.toThrow();
        },
        { timeout: 5_000, interval: 50 },
      );
      expect(x.matrix.router.hasPendingConfirmation()).toBe(false);
      expect(x.provider.spoken.join('')).not.toContain('选择哪一项');
      expect(x.adapter.started).toBe(false);
    } finally {
      x.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves app targets and audits the underlying launch', async () => {
    const x = await setupNavigation();
    try {
      const launch = vi.spyOn(x.desktop, 'launchApplication');
      x.provider.toolCall({
        callId: 'app',
        name: 'open_app',
        args: { app: 'chrome', target: 'https://example.com/page' },
      });
      await flush();
      await flush();
      expect(launch).toHaveBeenCalledWith('chrome', 'https://example.com/page');
      expect(x.matrix.registry.getUsage('app.launch').successes).toBe(1);
    } finally {
      x.dispose();
    }
  });

  it('does not open sensitive app targets or continue GUI before confirmation', async () => {
    const x = await setupNavigation();
    try {
      x.provider.toolCall({
        callId: 'sensitive',
        name: 'open_app',
        args: { app: 'notepad', target: '.env', task_instruction: '输入文本' },
      });
      await flush();
      await flush();
      expect(x.desktop.launched).toEqual([]);
      expect(x.adapter.started).toBe(false);
      expect(x.matrix.router.hasPendingConfirmation()).toBe(true);
      expect(x.provider.spoken).toContain('敏感操作，是否执行？');
    } finally {
      x.dispose();
    }
  });

  it('exposes one voice entry per operation without removing registry tools', async () => {
    const x = await setupNavigation();
    try {
      const names = buildVoiceToolSurface(x.matrix.providerCatalog.tools).map(
        (t) => t.function.name,
      );
      for (const name of ['search_web', 'open_url', 'open_app', 'open_site'])
        expect(names).toContain(name);
      for (const name of [
        'cyrvis_web_search',
        'cyrvis_web_open_url',
        'cyrvis_app_launch',
      ])
        expect(names).not.toContain(name);
      expect(new Set(names).size).toBe(names.length);
      expect(x.matrix.registry.get('web.search')).toBeDefined();
    } finally {
      x.dispose();
    }
  });

  it('creates deterministic text files without starting the GUI agent', async () => {
    const x = await setupNavigation();
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'cyrvis-text-file-'),
    );
    const file = path.join(directory, 'numbers.txt');
    try {
      x.provider.toolCall({
        callId: 'text-file',
        name: 'create_text_file',
        args: { path: file, content: '1\n2\n3', open: true },
      });
      // File I/O may outlive several event-loop ticks under parallel suites.
      // Wait for the actual tool receipt before reading or removing its output.
      await vi.waitFor(() =>
        expect(x.provider.toolResults.at(-1)?.output).toContain('FILE_CREATED'),
      );
      expect(await fs.readFile(file, 'utf8')).toBe('1\n2\n3');
      expect(x.adapter.started).toBe(false);
      await vi.waitFor(() => {
        expect(x.provider.toolResults.at(-1)?.output).toContain('FILE_CREATED');
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      x.dispose();
    }
  });

  it('blocks legacy opening after deterministic app launch', async () => {
    const x = await setupNavigation();
    try {
      x.provider.transcript('open notepad');
      await flush();
      await flush();
      x.provider.toolCall({
        callId: 'legacy',
        name: 'open_app',
        args: { app: 'notepad' },
      });
      await flush();
      expect(x.desktop.launched).toEqual(['notepad']);
      expect(x.provider.toolResults.at(-1)?.output).toContain(
        'ALREADY_HANDLED_BY_FAST_TOOL',
      );
    } finally {
      x.dispose();
    }
  });

  it.each(['cyrvis_web_search', 'cyrvis_capability_invoke'])(
    'checks site intent for %s',
    async (name) => {
      const x = await setupNavigation();
      try {
        x.provider.transcript('打开B站');
        x.provider.toolCall({
          callId: 'wrong',
          name,
          args:
            name === 'cyrvis_web_search'
              ? { query: 'B站' }
              : { toolId: 'web.search', arguments: { query: 'B站' } },
        } as VoiceToolCallWithId);
        await flush();
        expect(x.desktop.openedUrls).toEqual([]);
        expect(x.provider.toolResults.at(-1)?.output).toContain(
          'USE_OPEN_SITE',
        );
      } finally {
        x.dispose();
      }
    },
  );

  it('keeps knowledge answers out of broker web execution', async () => {
    const x = await setupNavigation();
    try {
      x.provider.transcript('介绍下邓小平');
      x.provider.toolCall({
        callId: 'knowledge',
        name: 'cyrvis_capability_invoke',
        args: {
          toolId: 'web.open_url',
          arguments: { url: 'https://example.com' },
        },
      });
      await flush();
      expect(x.desktop.openedUrls).toEqual([]);
      expect(x.provider.toolResults.at(-1)?.output).toContain(
        'ANSWER_FROM_KNOWLEDGE',
      );
    } finally {
      x.dispose();
    }
  });

  it('preserves site search and silent opening through the registry', async () => {
    const x = await setupNavigation();
    try {
      x.provider.transcript('打开B站搜一下猫，我自己看');
      x.provider.toolCall({
        callId: 'site',
        name: 'search_web',
        args: { query: '猫' },
      });
      await flush();
      await flush();
      expect(x.desktop.openedUrls).toEqual([
        buildSiteSearchUrl(resolveSite('bilibili')!, '猫'),
      ]);
      expect(x.provider.toolResults.at(-1)?.output).toContain(
        'without a summary',
      );
      expect(x.matrix.registry.getUsage('web.open_url').successes).toBe(1);
    } finally {
      x.dispose();
    }
  });

  it('preserves search engine and domain filter', async () => {
    const x = await setupNavigation();
    try {
      x.provider.transcript('搜索最新机票');
      x.provider.toolCall({
        callId: 'search',
        name: 'search_web',
        args: { query: '机票', engine: 'google', site: 'ctrip.com' },
      });
      await flush();
      await flush();
      expect(x.desktop.openedUrls).toEqual([
        buildSearchUrl('机票', 'google', 'ctrip.com'),
      ]);
    } finally {
      x.dispose();
    }
  });

  it('applies registry permissions to legacy navigation', async () => {
    const x = await setupNavigation(['network']);
    try {
      x.provider.toolCall({
        callId: 'denied',
        name: 'open_url',
        args: { url: 'https://example.com' },
      });
      await flush();
      await flush();
      expect(x.desktop.openedUrls).toEqual([]);
      expect(x.provider.toolResults.at(-1)?.output).toContain(
        'CAPABILITY_UNAVAILABLE',
      );
    } finally {
      x.dispose();
    }
  });

  it('deduplicates concurrent legacy and broker opening calls', async () => {
    const x = await setupNavigation();
    try {
      x.provider.toolCall({
        callId: 'old',
        name: 'open_url',
        args: { url: 'https://example.com' },
      });
      x.provider.toolCall({
        callId: 'broker',
        name: 'cyrvis_capability_invoke',
        args: {
          toolId: 'web.open_url',
          arguments: { url: 'https://example.com' },
        },
      });
      await flush();
      await flush();
      expect(x.desktop.openedUrls).toEqual(['https://example.com/']);
      expect(
        x.provider.toolResults.some((r) =>
          r.output.includes('ALREADY_HANDLED_BY_FAST_TOOL'),
        ),
      ).toBe(true);
    } finally {
      x.dispose();
    }
  });

  it('allows a new navigation request after a deterministic operation', async () => {
    const x = await setupNavigation();
    try {
      x.provider.transcript('open notepad');
      await flush();
      await flush();
      x.provider.transcript('打开B站');
      x.provider.toolCall({
        callId: 'next',
        name: 'open_site',
        args: { site: 'bilibili' },
      });
      await flush();
      await flush();
      expect(x.desktop.openedUrls).toHaveLength(1);
      expect(x.provider.toolResults.at(-1)?.output).toContain('opened');
    } finally {
      x.dispose();
    }
  });

  it('preserves GUI continuation after opening a page', async () => {
    const x = await setupNavigation();
    vi.useFakeTimers();
    try {
      x.provider.toolCall({
        callId: 'continue',
        name: 'open_url',
        args: {
          url: 'https://example.com',
          task_instruction: '点击页面上的登录按钮',
        },
      });
      await vi.advanceTimersByTimeAsync(1300);
      expect(x.desktop.openedUrls).toHaveLength(1);
      expect(x.adapter.started).toBe(true);
      expect(x.provider.toolResults.at(-1)?.output).toContain('TASK_STARTED');
    } finally {
      x.dispose();
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceBrain fast tool interception', () => {
  it('executes a simple command locally and blocks a racing GUI tool call', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('open notepad');
    provider.toolCall({
      callId: 'race-call',
      name: 'start_gui_task',
      args: { instruction: 'open notepad' },
    });
    provider.toolCall({
      callId: 'duplicate-local-call',
      name: 'cyrvis_app_launch',
      args: { name: 'notepad' },
    });
    await flush();
    await flush();

    expect(desktop.launched).toEqual(['notepad']);
    expect(adapter.started).toBe(false);
    expect(provider.canceled).toBeGreaterThan(0);
    expect(provider.spoken).toContain('正在打开notepad。');
    expect(provider.toolResults[0]?.output).toContain(
      'ALREADY_HANDLED_BY_FAST_TOOL',
    );
    expect(provider.toolResults[1]?.output).toContain(
      'ALREADY_HANDLED_BY_FAST_TOOL',
    );
  });

  it('auto-wakes on a deterministic fast-tool command', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: true,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('open notepad');
    await flush();
    await flush();

    expect(brain.getState().awake).toBe(true);
    expect(desktop.launched).toEqual(['notepad']);
  });

  it('minimizes all windows locally instead of dispatching the GUI agent', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('把所有桌面窗口最小化');
    provider.toolCall({
      callId: 'window-race',
      name: 'start_gui_task',
      args: { instruction: '把所有桌面窗口最小化' },
    });
    await flush();
    await flush();

    expect(desktop.minimizedAll).toBe(1);
    expect(adapter.started).toBe(false);
    expect(provider.spoken).toContain('已最小化 4 个可见窗口。');
    expect(provider.toolResults[0]?.output).toContain(
      'ALREADY_HANDLED_BY_FAST_TOOL',
    );
  });

  it('executes a local tool selected directly by the language model', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('让桌面清爽一点');
    provider.toolCall({
      callId: 'model-local-window',
      name: 'cyrvis_window_minimize_all',
      args: {},
    });
    await flush();
    await flush();

    expect(desktop.minimizedAll).toBe(1);
    expect(adapter.started).toBe(false);
    expect(provider.toolResults[0]?.output).toContain('"status":"completed"');
    expect(provider.toolResults[0]?.output).toContain('window.minimize_all');
  });

  it('allows GUI fallback after capability discovery finds no handled task', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('打开浏览器并登录我的邮箱');
    provider.toolCall({
      callId: 'capability-discovery',
      name: 'cyrvis_capability_search',
      args: { query: 'mail login' },
    });
    await flush();
    await flush();
    provider.toolCall({
      callId: 'gui-fallback',
      name: 'start_gui_task',
      args: { instruction: '打开浏览器并登录我的邮箱' },
    });
    await flush();
    await flush();

    expect(adapter.started).toBe(true);
    expect(provider.toolResults[0]?.output).toContain('"status":"completed"');
  });

  it('redirects a browser search GUI call to the local web search tool', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('网球王子这个信息帮我弄出来');
    provider.toolCall({
      callId: 'search-gui-fallback',
      name: 'start_gui_task',
      args: { instruction: '打开浏览器搜索网球王子' },
    });
    await flush();
    await flush();

    expect(adapter.started).toBe(false);
    expect(decodeURIComponent(desktop.openedUrls.at(-1) || '')).toContain(
      '网球王子',
    );
    expect(provider.toolResults.at(-1)?.output).toContain('"status":"opened"');
  });

  it('keeps high-risk tools behind confirmation and bypasses confirm self-echo filtering', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('处理一下记事本应用');
    provider.toolCall({
      callId: 'model-close-app',
      name: 'cyrvis_app_close',
      args: { name: 'notepad' },
    });
    await flush();
    await flush();

    expect(desktop.closed).toEqual([]);
    expect(provider.toolResults).toEqual([]);
    await vi.waitFor(() =>
      expect(provider.spoken.at(-1)).toBe('敏感操作，是否执行？'),
    );
    expect(provider.canceled).toBeGreaterThan(0);

    const confirmationPromptCount = provider.spoken.length;
    provider.toolCall({
      callId: 'model-close-app-repeat',
      name: 'cyrvis_app_close',
      args: { name: 'notepad' },
    });
    await flush();
    await flush();
    expect(provider.spoken).toHaveLength(confirmationPromptCount);

    provider.assistantText('敏感操作，是否执行？');
    provider.audio();

    const consumed = provider.transcript('是的，');
    expect(consumed).toBe(true);
    await flush();
    await flush();

    expect(desktop.closed).toEqual(['notepad']);
  });

  it('keeps an unlisted high-risk tool behind confirmation', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop, process.cwd(), undefined, {
      builtinProviders: { tools: [], manifests: [] },
    });
    let executed = false;
    matrix.registry.register({
      name: 'test.confirm',
      domain: 'system',
      description: 'Test confirmation-gated operation.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      prepare: () => ({}),
      requiresConfirmation: () => 'confirm test operation',
      execute: async () => {
        executed = true;
        return { ok: true, tool: 'test.confirm', speech: 'confirmed' };
      },
    });
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );

    try {
      await brain.start();
      provider.transcript('处理一下这个高敏感操作');
      provider.toolCall({
        callId: 'pending-confirm',
        name: 'cyrvis_test_confirm',
        args: {},
      });
      await flush();
      await flush();
      await flush();
      await flush();
      expect(executed).toBe(false);
      expect(matrix.router.hasPendingConfirmation()).toBe(true);
      provider.transcript('确认执行');
      await flush();
      await flush();
      expect(executed).toBe(true);
    } finally {
      matrix.dispose();
      brain.dispose();
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'speaks confirmation for a high-risk capability invoked through the broker',
    async () => {
      const adapter = new NoopGUIAdapter();
      const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
      const desktop = new FakeDesktopHost();
      const matrix = createFastToolMatrix(desktop);
      let provider!: FakeProvider;
      const brain = new VoiceBrain(
        controller,
        {},
        (callbacks) => {
          provider = new FakeProvider(callbacks);
          return provider;
        },
        {
          requireWakeWord: false,
          fastToolRouter: matrix.router,
        },
      );
      await brain.start();

      provider.transcript('处理一下记事本应用');
      provider.toolCall({
        callId: 'broker-close-app',
        name: 'cyrvis_capability_invoke',
        args: {
          toolId: 'app.close',
          arguments: { name: 'notepad' },
        },
      });
      await flush();
      await flush();

      expect(desktop.closed).toEqual([]);
      expect(provider.toolResults).toEqual([]);
      await vi.waitFor(() =>
        expect(provider.spoken.at(-1)).toBe('敏感操作，是否执行？'),
      );
      expect(provider.canceled).toBeGreaterThan(0);
      expect(matrix.router.hasPendingConfirmation()).toBe(true);

      provider.transcript('确认执行');
      await flush();
      await flush();
      expect(desktop.closed).toEqual(['notepad']);
    },
  );

  it('does not leave a stale confirmation after an explicit close command', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('关闭应用记事本');
    await flush();
    expect(desktop.closed).toEqual([]);
    expect(matrix.router.hasPendingConfirmation()).toBe(true);

    provider.transcript('取消');
    await flush();
    expect(desktop.closed).toEqual([]);
    expect(matrix.router.hasPendingConfirmation()).toBe(false);

    provider.transcript('关闭应用记事本');
    await flush();
    expect(desktop.closed).toEqual([]);
    provider.transcript('确认执行');
    await flush();
    await flush();
    expect(desktop.closed).toEqual(['记事本']);
  });

  it('speaks final assistant text when no audio was generated', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.responseStarted();
    provider.assistantText('这是一条需要在聊天框和语音中同时出现的重要信息。');
    provider.responseDone();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(provider.spoken).toContain(
      '这是一条需要在聊天框和语音中同时出现的重要信息。',
    );
  });

  it('does not duplicate a speech-text response that is already being synthesized', async () => {
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.responseStarted();
    provider.assistantText('已经有 TTS 输入的回复。');
    provider.speechText('已经有 TTS 输入的回复。');
    provider.responseDone();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(provider.spoken).not.toContain('已经有 TTS 输入的回复。');
  });

  it('guarantees a fallback reply when a user turn produces no output', async () => {
    vi.useFakeTimers();
    const adapter = new NoopGUIAdapter();
    const controller = new CyrvisController(adapter, { stallTimeoutMs: 0 });
    const desktop = new FakeDesktopHost();
    const matrix = createFastToolMatrix(desktop);
    let provider!: FakeProvider;
    const brain = new VoiceBrain(
      controller,
      {},
      (callbacks) => {
        provider = new FakeProvider(callbacks);
        return provider;
      },
      {
        requireWakeWord: false,
        fastToolRouter: matrix.router,
      },
    );
    await brain.start();

    provider.transcript('请解释一个比较复杂的问题');
    await vi.advanceTimersByTimeAsync(6000);

    expect(provider.spoken).toContain('我在，马上回答。');
  });
});
