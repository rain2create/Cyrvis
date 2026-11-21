/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export type IntentKind = 'chat' | 'task' | 'control' | 'ambiguous';

export interface IntentDecision {
  kind: IntentKind;
  reason: string;
}

const CONTROL_PATTERNS: RegExp[] = [
  /^(停|停止|停下|别动|取消|取消任务|暂停|等一下|等等|继续|恢复|状态|进度|现在怎么样)/,
  /(到哪一步|到哪了|什么进度|当前状态)/,
  /\b(stop|cancel|pause|resume|status|progress)\b/,
];

const TASK_VERBS: RegExp[] = [
  /(艾特|发送|转发|发(?:一个|一张|个|条).{0,8}(?:表情|消息|图片)|给.{1,12}发)/,
  /(打开|启动|关闭|关掉|搜索|搜一下|查一下|查询|点击|点一下|双击|输入|填写|保存|保存到|下载|下载到|安装|运行|操作|进入|切换到|帮我|给我|把.+|创建|新建|写入|写到|写在|生成|制作|编辑|修改|复制|移动到|删除|重命名|整理|放到|存到|解压|压缩|截图|录屏|翻译文件)/,
  /\b(open|launch|close|search|click|double|type|save|download|install|run|navigate|go to|switch to|create|write|rename|delete|copy|move|edit|modify|generate)\b/,
];

const CHAT_PATTERNS: RegExp[] = [
  /(你好|您好|早上好|晚上好|嗨|谢谢|多谢|你是谁|你叫什么|你叫什么名字|你在吗|在吗|你能做什么|你会什么|最近如何|怎么样|再见|拜拜)/,
  /\b(hello|hi|hey|thanks|thank you|who are you|what can you do|good morning|good evening|goodbye|bye)\b/,
];

const POINTER_PATTERNS: RegExp[] = [
  /(这个|那个|它|它们|左边|右边|上面|下面|刚才那个|刚才的)/,
  /\b(this|that|it|left|right|the one)\b/,
];

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:：""''“”‘’\s]/g, '')
    .trim();

const matches = (patterns: RegExp[], text: string): boolean =>
  patterns.some((pattern) => pattern.test(text));

/**
 * Small, deterministic gate that prevents greetings/chit-chat from being sent
 * to the GUI agent. The voice model is still responsible for the actual
 * conversation; this is the last line of defense before Controller.startTask.
 */
export const classifyIntent = (text: string): IntentDecision => {
  const raw = text.trim();
  const lower = raw.toLowerCase();
  const normalized = normalize(raw);

  if (!normalized) {
    return { kind: 'ambiguous', reason: 'empty' };
  }

  if (matches(CONTROL_PATTERNS, lower)) {
    return { kind: 'control', reason: 'control phrase' };
  }

  const hasTaskVerb = matches(TASK_VERBS, lower);
  const hasPointer = matches(POINTER_PATTERNS, lower);
  const hasChat = matches(CHAT_PATTERNS, lower);

  // "打开那个" / "点击左边那个" needs clarification, not execution.
  if (hasTaskVerb && hasPointer && normalized.length <= 12) {
    return { kind: 'ambiguous', reason: 'task verb with pointer target' };
  }

  if (hasTaskVerb) {
    return { kind: 'task', reason: 'task verb' };
  }

  if (hasPointer) {
    return { kind: 'ambiguous', reason: 'pointer without task verb' };
  }

  if (hasChat) {
    return { kind: 'chat', reason: 'greeting/chit-chat' };
  }

  // Default to chat: it is safer to answer than to start GUI automation.
  if (normalized.length <= 20) {
    return { kind: 'chat', reason: 'short conversational text' };
  }

  return {
    kind: 'ambiguous',
    reason: 'no clear action or conversational intent',
  };
};

export const isGuiTask = (text: string): boolean =>
  classifyIntent(text).kind === 'task';

/** True only for explicit greetings/thanks/identity questions, not for the
 * generic short-text fallback in `classifyIntent`. Text that contains a task
 * verb is never treated as pure chat, even if it contains a word like "hello"
 * as the content to type. */
export const isExplicitChat = (text: string): boolean => {
  const lower = text.trim().toLowerCase();
  if (matches(TASK_VERBS, lower) || matches(CONTROL_PATTERNS, lower)) {
    return false;
  }
  return matches(CHAT_PATTERNS, lower);
};
