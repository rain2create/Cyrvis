/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import { classifyIntent, isGuiTask } from './intent-gate';

describe('classifyIntent', () => {
  it.each([
    ['你好', 'chat'],
    ['你好呀', 'chat'],
    ['hello', 'chat'],
    ['谢谢', 'chat'],
    ['你能做什么', 'chat'],
    ['你是谁', 'chat'],
  ])('routes conversational text to chat: %s', (text, kind) => {
    expect(classifyIntent(text).kind).toBe(kind);
  });

  it.each([
    ['打开记事本', 'task'],
    ['打开 Chrome 搜索 UI-TARS', 'task'],
    ['帮我查一下天气', 'task'],
    ['open Notepad and type hello', 'task'],
    ['关闭浏览器', 'task'],
    ['save the page as PDF', 'task'],
    ['然后你现在艾特我刚才注视的这个人，给他发一个表情包', 'task'],
  ])('routes actionable text to task: %s', (text, kind) => {
    expect(classifyIntent(text).kind).toBe(kind);
  });

  it.each([
    ['停', 'control'],
    ['停止', 'control'],
    ['取消任务', 'control'],
    ['现在到哪一步了', 'control'],
    ['暂停一下', 'control'],
    ['stop', 'control'],
    ['status', 'control'],
  ])('routes control phrases: %s', (text, kind) => {
    expect(classifyIntent(text).kind).toBe(kind);
  });

  it.each([
    ['打开那个', 'ambiguous'],
    ['点击左边那个', 'ambiguous'],
    ['把刚才那个关掉', 'ambiguous'],
  ])('asks for clarification on pointer targets: %s', (text, kind) => {
    expect(classifyIntent(text).kind).toBe(kind);
  });

  it('never sends greetings to the GUI agent', () => {
    expect(isGuiTask('你好')).toBe(false);
    expect(isGuiTask('hello, how are you?')).toBe(false);
    expect(isGuiTask('打开记事本')).toBe(true);
  });

  it('treats a wake word plus a task as a task', () => {
    expect(classifyIntent('Hello CYRVIS, open Notepad').kind).toBe('task');
  });

  it('treats file creation tasks as tasks', () => {
    expect(
      classifyIntent('在桌面新建一个txt文件，并将《沁园春·雪》全文写入其中')
        .kind,
    ).toBe('task');
    expect(classifyIntent('给我创建一个桌面文件').kind).toBe('task');
    expect(classifyIntent('create a file on the desktop').kind).toBe('task');
  });
});
