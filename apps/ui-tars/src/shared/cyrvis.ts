/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export type TaskStatus =
  | 'idle'
  | 'starting'
  | 'executing'
  | 'paused'
  | 'cancelling'
  | 'done'
  | 'failed'
  | 'cancelled';

export type TaskSource = 'voice' | 'text';

export interface TaskSnapshot {
  taskId: string | null;
  status: TaskStatus;
  instruction: string | null;
  source: TaskSource | null;
  step: number;
  lastSummary: string | null;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface StepUpdate {
  index: number;
  summary: string;
  actionType: string;
}

export type ControllerEvent =
  | {
      type: 'task_started';
      taskId: string;
      instruction: string;
      source: TaskSource;
    }
  | { type: 'task_executing'; taskId: string }
  | {
      type: 'step_update';
      taskId: string;
      step: number;
      summary: string;
      actionType: string;
    }
  | { type: 'task_stalled'; taskId: string; step: number }
  | { type: 'task_needs_user'; taskId: string; question: string }
  | { type: 'task_paused'; taskId: string }
  | { type: 'task_resumed'; taskId: string }
  | { type: 'task_cancelling'; taskId: string }
  | { type: 'task_done'; taskId: string; summary: string }
  | { type: 'task_failed'; taskId: string; error: string }
  | { type: 'task_cancelled'; taskId: string };

export interface CyrvisVoiceState {
  awake: boolean;
  userSpeaking: boolean;
  ttsSpeaking: boolean;
  /** Gaze readouts ignore energy-only echo; explicit stop/KWS still works. */
  readoutGuardUntil?: number;
  lastUserText: string;
  task: TaskSnapshot;
}

export type VoiceToolName =
  | 'inspect_gaze_target'
  | 'start_gui_task'
  | 'cancel_gui_task'
  | 'pause_gui_task'
  | 'resume_gui_task'
  | 'get_gui_status'
  | 'confirm_action'
  | 'remember_fact'
  | 'travel_update_plan'
  | 'travel_get_plan'
  | 'travel_confirm_skeleton'
  | 'travel_probe_highlights'
  | 'travel_set_preference'
  | 'travel_set_constraints'
  | 'travel_expand_aspect'
  | 'travel_search'
  | 'travel_decline_expand'
  | 'travel_finalize_plan'
  | 'close_webpage'
  | 'create_presentation';

export type CyrvisMemoryTurnRole = 'user' | 'assistant';

export type GazeChatPhase =
  | 'capturing'
  | 'recognizing'
  | 'recognized'
  | 'queued'
  | 'generating'
  | 'audio'
  | 'playing'
  | 'spoken'
  | 'failed'
  | 'cancelled';
export interface GazeChatTurn {
  id: string;
  createdAt: number;
  updatedAt: number;
  trigger: 'manual' | 'proactive';
  question: string;
  preview?: string;
  answer?: string;
  phase: GazeChatPhase;
  error?: string;
}

export interface CyrvisMemoryTurn {
  id: string;
  role: CyrvisMemoryTurnRole;
  text: string;
  createdAt: number;
}

export type CyrvisActivityKind =
  | 'session'
  | 'speech'
  | 'tool'
  | 'task'
  | 'memory'
  | 'error';

export interface CyrvisActivityEvent {
  id: string;
  kind: CyrvisActivityKind;
  text: string;
  createdAt: number;
}

export interface CyrvisMemorySnapshot {
  turns: CyrvisMemoryTurn[];
  activities: CyrvisActivityEvent[];
  facts: string[];
}

export interface CyrvisContextResource {
  id: string;
  kind: string;
  name: string;
  active: boolean;
  health: string;
  providerIds: string[];
}

export interface CyrvisContextSnapshot {
  revision: number;
  updatedAt: number;
  activeApplication: string | null;
  activeWindow: string | null;
  focusedControl: string | null;
  recentActions: Array<{
    toolId: string;
    ok: boolean;
    at: number;
  }>;
  recentResources: CyrvisContextResource[];
  fallbackResources: CyrvisContextResource[];
  currentTask: {
    taskId: string;
    status: string;
    instruction: string | null;
  } | null;
}

const TERMINAL_TASK_STATUSES: TaskStatus[] = [
  'idle',
  'done',
  'failed',
  'cancelled',
];

/** User-facing task titles must not expose generated gaze JSON/instructions. */
export function taskDisplayInstruction(instruction: string): string {
  const marker = instruction.indexOf('\n[已绑定注视对象]');
  return marker < 0
    ? instruction
    : instruction
        .slice(0, marker)
        .replace(/^用户明确要求在当前桌面界面执行操作：/, '')
        .trim();
}

export const isActiveTaskStatus = (status: TaskStatus): boolean =>
  !TERMINAL_TASK_STATUSES.includes(status);

export const describeVoiceToolCall = (
  name: VoiceToolName,
  instruction?: string,
): string => {
  switch (name) {
    case 'inspect_gaze_target':
      return '识别当前注视区域';
    case 'start_gui_task':
      return instruction
        ? `启动电脑任务：${taskDisplayInstruction(instruction)}`
        : '启动电脑任务';
    case 'cancel_gui_task':
      return '取消电脑任务';
    case 'pause_gui_task':
      return '暂停电脑任务';
    case 'resume_gui_task':
      return '继续电脑任务';
    case 'get_gui_status':
      return '查询任务状态';
    case 'confirm_action':
      return '确认任务操作';
    case 'remember_fact':
      return '保存长期记忆';
    case 'travel_update_plan':
      return '更新旅行基础框架';
    case 'travel_get_plan':
      return '查看旅行规划状态';
    case 'travel_confirm_skeleton':
      return '确认旅行骨架攻略';
    case 'travel_probe_highlights':
      return '检索旅行大类亮点';
    case 'travel_set_preference':
      return '记录旅行偏好';
    case 'travel_set_constraints':
      return '记录旅行约束卡片';
    case 'travel_expand_aspect':
      return '展开旅行攻略方面';
    case 'travel_search':
      return '检索旅行信息';
    case 'travel_decline_expand':
      return '暂停旅行攻略展开';
    case 'travel_finalize_plan':
      return '生成旅行计划桌面摘要';
    case 'close_webpage':
      return '关闭指定网页';
    case 'create_presentation':
      return '生成演示文稿';
    default:
      return '调用语音工具';
  }
};

export const describeControllerEvent = (
  event: ControllerEvent,
): string | null => {
  switch (event.type) {
    case 'task_started':
      return `开始任务：${taskDisplayInstruction(event.instruction)}`;
    case 'task_executing':
      return 'GUI Agent 已开始执行';
    case 'step_update':
      return `步骤 ${event.step}：${event.summary}`;
    case 'task_stalled':
      return `任务等待中，当前步骤 ${event.step}`;
    case 'task_needs_user':
      return `需要确认：${event.question}`;
    case 'task_paused':
      return '任务已暂停';
    case 'task_resumed':
      return '任务已继续';
    case 'task_cancelling':
      return '正在停止任务';
    case 'task_done':
      return event.summary || '任务已完成';
    case 'task_failed':
      return `任务失败：${event.error}`;
    case 'task_cancelled':
      return '任务已取消';
    default:
      return null;
  }
};
