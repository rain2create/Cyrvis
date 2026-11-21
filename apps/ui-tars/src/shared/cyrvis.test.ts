import { describe, expect, it } from 'vitest';

import {
  describeControllerEvent,
  describeVoiceToolCall,
  isActiveTaskStatus,
  taskDisplayInstruction,
  type ControllerEvent,
} from './cyrvis';

describe('Cyrvis shared UI model', () => {
  it('shows the user request without generated gaze JSON or internal instructions', () => {
    expect(
      taskDisplayInstruction(
        '用户明确要求在当前桌面界面执行操作：播放它\n[已绑定注视对象] reference={"objectBounds":{}}\n内部要求',
      ),
    ).toBe('播放它');
    expect(taskDisplayInstruction('打开网易云音乐')).toBe('打开网易云音乐');
  });
  it('treats only live task phases as active', () => {
    expect(isActiveTaskStatus('starting')).toBe(true);
    expect(isActiveTaskStatus('executing')).toBe(true);
    expect(isActiveTaskStatus('paused')).toBe(true);
    expect(isActiveTaskStatus('cancelling')).toBe(true);
    expect(isActiveTaskStatus('idle')).toBe(false);
    expect(isActiveTaskStatus('done')).toBe(false);
    expect(isActiveTaskStatus('failed')).toBe(false);
    expect(isActiveTaskStatus('cancelled')).toBe(false);
  });

  it('formats controller events for the floating activity feed', () => {
    const events: ControllerEvent[] = [
      {
        type: 'task_started',
        taskId: 'task-1',
        instruction: 'Open settings',
        source: 'voice',
      },
      {
        type: 'step_update',
        taskId: 'task-1',
        step: 3,
        summary: 'Click Appearance',
        actionType: 'click',
      },
      {
        type: 'task_done',
        taskId: 'task-1',
        summary: 'Settings opened',
      },
    ];

    expect(events.map(describeControllerEvent)).toEqual([
      '开始任务：Open settings',
      '步骤 3：Click Appearance',
      'Settings opened',
    ]);
  });

  it('formats lifecycle-only phases', () => {
    expect(
      describeControllerEvent({ type: 'task_executing', taskId: 'x' }),
    ).toBe('GUI Agent 已开始执行');
  });

  it('formats voice tool calls for activity history', () => {
    expect(describeVoiceToolCall('start_gui_task', '打开记事本')).toBe(
      '启动电脑任务：打开记事本',
    );
    expect(describeVoiceToolCall('remember_fact')).toBe('保存长期记忆');
    expect(describeVoiceToolCall('travel_update_plan')).toBe(
      '更新旅行基础框架',
    );
    expect(describeVoiceToolCall('travel_expand_aspect')).toBe(
      '展开旅行攻略方面',
    );
  });
});
