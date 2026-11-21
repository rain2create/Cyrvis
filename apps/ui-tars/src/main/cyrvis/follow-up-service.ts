/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import ElectronStore from 'electron-store';
import { execFile, type ChildProcess } from 'node:child_process';

import { logger } from '@main/logger';
import { showMainWindow } from '@main/window/index';
import type { CyrvisMemorySnapshot } from '@shared/cyrvis';
import { voiceMemoryService } from './memory';
import { travelPlanner } from './travel/travel-planner';
import {
  publishProactiveText,
  shouldDeferFollowUpSpeech,
  speakProactiveText,
} from './voice-service';

export type FollowUpReason =
  | 'launch'
  | 'activate'
  | 'resume'
  | 'unlock'
  | 'idle';

export interface FollowUpPrompt {
  id: string;
  reason: FollowUpReason;
  createdAt: number;
  greeting: string;
}

interface FollowUpState {
  enabled: boolean;
  snoozedUntil: number;
  lastPromptAt: number;
  lastGreeting: string;
  pending: FollowUpPrompt | null;
}

const PROMPT_GAP_MS = 30 * 60 * 1000;
const DEFAULT_SNOOZE_MS = 30 * 60 * 1000;
const LIFECYCLE_DEDUPE_MS = 10_000;

const pickDifferent = (choices: string[], previous: string): string => {
  const candidates = choices.filter((choice) => choice !== previous);
  const pool = candidates.length ? candidates : choices;
  return pool[Math.floor(Math.random() * pool.length)] || choices[0] || '';
};

const createGreeting = (
  date: Date,
  busyYesterday: boolean,
  previous: string,
): string => {
  const hour = date.getHours();
  const day = date.getDay();
  const isWeekend = day === 0 || day === 6;

  if (isWeekend) {
    return pickDifferent(
      [
        '周末好呀，今天想出去走走，还是舒舒服服宅一会儿？',
        '周末上线。工作可以慢一点，快乐可别迟到。',
        '今天是周末，有没有出行计划？需要的话我也能帮你一起安排。',
        '欢迎回来。周末也要记得给自己留一点放空时间。',
      ],
      previous,
    );
  }

  if (busyYesterday) {
    return pickDifferent(
      [
        '欢迎回来。昨天忙了不少，今天休息得还好吗？',
        '昨天工作量挺大，今天我们稳一点，别把自己累着。',
        '又见面啦。昨天推进了很多事情，今天也记得留点喘气的空间。',
      ],
      previous,
    );
  }

  if (hour < 6) {
    return pickDifferent(
      [
        '夜深了，还在努力呀。别忘了，休息也是任务的一部分。',
        '这么晚还见到你，辛苦啦。我们尽量速战速决。',
        '深夜模式已开启。剩下的事情慢慢来，别太为难自己。',
      ],
      previous,
    );
  }
  if (hour < 11) {
    return pickDifferent(
      [
        '早上好，新的一天开工啦，今天也稳稳向前。',
        '早呀，祝你今天思路清晰、一路绿灯。',
        '新的一天见面啦。打起精神，我们把事情一件件搞定。',
      ],
      previous,
    );
  }
  if (hour < 14) {
    return pickDifferent(
      [
        '中午好，忙归忙，也要记得按时吃饭。',
        '午间上线。上午辛苦了，下午继续稳稳推进。',
        '中午好呀，先补充能量，再继续解决问题。',
      ],
      previous,
    );
  }
  if (hour < 18) {
    return pickDifferent(
      [
        '下午好，今天的进度条已经过半，继续加油。',
        '欢迎回来。下午也要保持节奏，别被琐事牵着跑。',
        '下午好呀，再推进一点，离收工就更近一步。',
      ],
      previous,
    );
  }
  return pickDifferent(
    [
      '晚上好，今天辛苦了。需要我帮你收个尾吗？',
      '欢迎回来。忙了一天，我们把剩下的事情轻松处理掉。',
      '晚上好呀，今天已经很努力了，接下来别给自己太大压力。',
    ],
    previous,
  );
};

const clipDetail = (text: string, max = 48): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
};

/** Greetings / status checks — never quote these as the “task topic”. */
const isLowSignalUtterance = (text: string): boolean => {
  const t = text.replace(/\s+/g, '').trim();
  if (!t || t.length < 4) return true;
  if (
    /^(你好|您好|嗨|在吗|嘿|嗯|好的|好|行|谢谢|收到|继续|然后呢|ok|hi|hello)[吗呀啊呢。！？!?.]*$/i.test(
      t,
    )
  ) {
    return true;
  }
  return /(删除了吗|做完了吗|好了吗|完成了吗|弄好了吗|怎么样了|还在吗|听见了吗)/.test(
    t,
  );
};

const stripTaskPrefix = (text: string): string =>
  text
    .replace(/^启动电脑任务[:：]\s*/, '')
    .replace(/^(已经|已|我)?(帮你)?/, '')
    .trim();

/** Prefer action summary over echoing the latest user sentence. */
const synthesizeRecentWork = (
  memory: CyrvisMemorySnapshot,
): { action: string; objectHint: string | null } | null => {
  const recentActivities = [...memory.activities].slice(-8).reverse();
  for (const activity of recentActivities) {
    const raw = stripTaskPrefix(activity.text);
    if (!raw || isLowSignalUtterance(raw)) continue;
    if (
      activity.kind === 'task' ||
      /启动电脑任务|删除|新建|创建|写入|打开|整理|下载|保存|旅行计划/.test(
        activity.text,
      )
    ) {
      return {
        action: clipDetail(raw, 36),
        objectHint: raw.match(/桌面|旅行计划|文件|文件夹|记事本/)?.[0] || null,
      };
    }
  }

  const recentAssistant = [...memory.turns]
    .filter((turn) => turn.role === 'assistant')
    .slice(-6)
    .reverse();
  for (const turn of recentAssistant) {
    const text = turn.text.trim();
    if (isLowSignalUtterance(text)) continue;
    const done =
      text.match(
        /(?:已|已经)?(?:帮你)?(删(?:除|掉)|清理|新建|创建|写入|保存|打开|整理|下载)[^。！？!?]{0,28}/,
      )?.[0] || text.match(/桌面上的[^。！？!?]{0,20}(?:文件|计划)/)?.[0];
    if (done) {
      return { action: clipDetail(done, 36), objectHint: null };
    }
  }

  const substantiveUser = [...memory.turns]
    .filter((turn) => turn.role === 'user')
    .slice(-10)
    .reverse()
    .map((turn) => turn.text.trim())
    .find(
      (text) =>
        !isLowSignalUtterance(text) &&
        /(删|删除|清理|新建|创建|写入|打开|整理|下载|保存|帮我|给我|把.+|旅行|计划|文件)/.test(
          text,
        ),
    );
  if (substantiveUser) {
    const intent =
      substantiveUser.match(
        /(?:帮我|给我|请)?(.{0,4}(?:删(?:除|掉)|清理|新建|创建|写入|打开|整理|下载|保存)[^，。！？!?]{0,28})/,
      )?.[1] || substantiveUser;
    return { action: clipDetail(intent, 36), objectHint: null };
  }

  return null;
};

const buildResumeFromMemoryFallback = (
  memory: CyrvisMemorySnapshot,
): string | null => {
  const work = synthesizeRecentWork(memory);
  if (work) {
    const second =
      work.objectHint && !work.action.includes(work.objectHint)
        ? `当时主要围绕${work.objectHint}在推进`
        : '内容和步骤已经有一部分进展';
    return `上次你让我${work.action}。${second}。需要继续完善这个任务吗？`;
  }

  const recentAssistant = [...memory.turns]
    .reverse()
    .find(
      (turn) => turn.role === 'assistant' && !isLowSignalUtterance(turn.text),
    );
  if (!recentAssistant) return null;
  return `上次我们推进到：${clipDetail(recentAssistant.text, 40)}。需要继续完善这个任务吗？`;
};

/** Launch/activate/resume: summarize last task instead of a bare continue ask. */
const buildLifecycleResumeInvite = (memory: CyrvisMemorySnapshot): string => {
  // Prefer concrete recent work (delete/file/GUI) over stale travel rehydration.
  const work = synthesizeRecentWork(memory);
  const nonTravelWork =
    work && !/(旅行|行程|机票|酒店|门票|滑雪|攻略)/.test(work.action);
  if (nonTravelWork) {
    return (
      buildResumeFromMemoryFallback(memory) ||
      '上次的事情还留着一点尾巴。需要继续完善这个任务吗？'
    );
  }

  const live = travelPlanner.getSnapshot();
  const travelActive =
    Boolean(live.framework.destination) &&
    (live.aspects.length > 0 ||
      Boolean(live.primaryInterest) ||
      (live.phase !== 'idle' && live.phase !== 'done'));
  if (travelActive) {
    const overview = travelPlanner.buildResumeOverview();
    if (overview) {
      const detailText =
        overview.details.length > 0
          ? `${overview.details.join('。')}。`
          : '具体方案还可以接着补。';
      return `${overview.headline}。${detailText}需要继续完善这个任务吗？`;
    }
  }

  return (
    buildResumeFromMemoryFallback(memory) ||
    '上次的事情还留着一点尾巴。需要继续完善这个任务吗？'
  );
};

const followUpStore = new ElectronStore<FollowUpState>({
  name: 'cyrvis-proactivity',
  defaults: {
    enabled: true,
    snoozedUntil: 0,
    lastPromptAt: 0,
    lastGreeting: '',
    pending: null,
  },
});

let registered = false;
let localSpeechProcess: ChildProcess | null = null;
let lastLifecyclePromptAt = 0;

const speakLocally = (text: string): void => {
  // macOS fallback only — Windows uses the realtime voice session.
  if (process.platform !== 'darwin') {
    logger.warn(
      '[cyrvis follow-up] local TTS skipped on this platform; showing text only',
    );
    return;
  }
  localSpeechProcess?.kill();
  localSpeechProcess = execFile(
    '/usr/bin/say',
    ['-v', 'Tingting', '-r', '185', text],
    (error) => {
      localSpeechProcess = null;
      if (!error) return;
      logger.warn('[cyrvis follow-up] Chinese voice unavailable', error);
      localSpeechProcess = execFile('/usr/bin/say', ['-r', '180', text], () => {
        localSpeechProcess = null;
      });
    },
  );
};

const stopLocalSpeech = (): void => {
  if (localSpeechProcess && !localSpeechProcess.killed) {
    localSpeechProcess.kill();
    localSpeechProcess = null;
  }
};

const broadcastPrompt = (prompt: FollowUpPrompt): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('cyrvis:follow-up:prompt', prompt);
    }
  }
};

const enrichAndSpeak = async (prompt: FollowUpPrompt): Promise<void> => {
  const pending = followUpStore.get('pending');
  if (!pending || pending.id !== prompt.id) return;

  const now = new Date(prompt.createdAt);
  const yesterdayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  ).getTime();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const memory = await voiceMemoryService.getSnapshot();
  const latestPending = followUpStore.get('pending');
  if (!latestPending || latestPending.id !== prompt.id) return;
  const yesterdayItems = [...memory.turns, ...memory.activities].filter(
    (item) => item.createdAt >= yesterdayStart && item.createdAt < todayStart,
  ).length;
  const previousGreeting = followUpStore.get('lastGreeting');
  const greeting = createGreeting(now, yesterdayItems >= 8, previousGreeting);
  const resumeInvite = buildLifecycleResumeInvite(memory);
  // Lifecycle speech = short hello + task summary + continue ask.
  const speech = `${greeting}${resumeInvite}`;

  const enriched = {
    ...prompt,
    greeting: speech,
  };
  followUpStore.set({
    ...followUpStore.store,
    lastGreeting: speech,
    pending: enriched,
  });
  broadcastPrompt(enriched);

  if (shouldDeferFollowUpSpeech()) {
    logger.info(
      '[cyrvis follow-up] kept greeting in panel while attention is busy',
    );
    return;
  }

  // Always mirror proactive lines into the transcript/memory.
  publishProactiveText(speech);
  if (!speakProactiveText(speech)) {
    speakLocally(speech);
  }
};

export const requestFollowUp = (
  reason: FollowUpReason,
  options: { force?: boolean; revealWindow?: boolean } = {},
): FollowUpPrompt | null => {
  // 10s silence idle prompts were too chatty — disabled on purpose.
  if (reason === 'idle') return null;

  const now = Date.now();
  const enabled = followUpStore.get('enabled');
  const snoozedUntil = followUpStore.get('snoozedUntil');
  const lastPromptAt = followUpStore.get('lastPromptAt');

  if (
    !enabled ||
    now < snoozedUntil ||
    (!options.force && now - lastPromptAt < PROMPT_GAP_MS)
  ) {
    return null;
  }

  const prompt: FollowUpPrompt = {
    id: `${reason}-${now}`,
    reason,
    createdAt: now,
    greeting: '',
  };
  lastLifecyclePromptAt = now;
  followUpStore.set({
    ...followUpStore.store,
    lastPromptAt: now,
    pending: prompt,
  });

  if (options.revealWindow) {
    void showMainWindow();
  }
  void enrichAndSpeak(prompt);
  logger.info('[cyrvis follow-up] prompt', prompt);
  return prompt;
};

export const registerFollowUpService = (): void => {
  if (registered) return;
  registered = true;
  // Avoid duplicate lifecycle prompts during startup.
  lastLifecyclePromptAt = Date.now();

  ipcMain.handle('cyrvis:follow-up:get-pending', () =>
    followUpStore.get('pending'),
  );
  ipcMain.handle('cyrvis:follow-up:complete', (_event, id: unknown) => {
    stopLocalSpeech();
    const pending = followUpStore.get('pending');
    logger.info('[cyrvis follow-up] complete', {
      id,
      pendingId: pending?.id ?? null,
    });
    if (!pending || pending.id === id) followUpStore.set('pending', null);
    return { ok: true };
  });
  ipcMain.handle(
    'cyrvis:follow-up:snooze',
    (_event, id: unknown, delayMs: unknown) => {
      stopLocalSpeech();
      const pending = followUpStore.get('pending');
      if (!pending || pending.id === id) followUpStore.set('pending', null);
      const safeDelay =
        typeof delayMs === 'number' && delayMs > 0
          ? Math.min(delayMs, 24 * 60 * 60 * 1000)
          : DEFAULT_SNOOZE_MS;
      followUpStore.set('snoozedUntil', Date.now() + safeDelay);
      return { ok: true, snoozedUntil: followUpStore.get('snoozedUntil') };
    },
  );

  const requestLifecycleFollowUp = (reason: FollowUpReason): void => {
    const now = Date.now();
    if (now - lastLifecyclePromptAt < LIFECYCLE_DEDUPE_MS) return;
    requestFollowUp(reason, { force: true, revealWindow: true });
  };

  powerMonitor.on('resume', () => requestLifecycleFollowUp('resume'));
  powerMonitor.on('unlock-screen', () => requestLifecycleFollowUp('unlock'));

  app.once('before-quit', () => {
    stopLocalSpeech();
  });
};
