import { describe, expect, it } from 'vitest';
import { conversationTurns } from './conversation-view';
import type { ConversationWithSoM } from '../main/shared/types';

describe('conversation presentation', () => {
  it('retains a gaze image and its status as one turn alongside ordinary chat', () => {
    const gazeTurn = {
      id: 'shot',
      createdAt: 1,
      updatedAt: 2,
      trigger: 'manual' as const,
      question: '看这里',
      preview: 'data:image/jpeg;base64,dGVzdA==',
      answer: '音乐封面',
      phase: 'playing' as const,
    };
    const turns = conversationTurns([
      { from: 'human', value: '看这里', gazeTurn },
      { from: 'human', value: '播放它' },
      { from: 'gpt', value: '正在交给桌面执行器。' },
    ]);
    expect(turns.map((turn) => turn.role)).toEqual([
      'gaze',
      'human',
      'assistant',
    ]);
    expect(turns[0].gazeTurn).toEqual(gazeTurn);
  });
  it('groups recorded actions with their final answer across screenshot-only records', () => {
    const messages: ConversationWithSoM[] = [
      { from: 'human', value: 'Organize my notes' },
      {
        from: 'gpt',
        value: 'raw model response',
        predictionParsed: [
          {
            action_type: 'click',
            action_inputs: { start_box: '[1,2]' },
            thought: 'private analysis',
            reflection: 'private reflection',
          },
        ],
      },
      { from: 'human', value: '<image>', screenshotBase64: 'old-image' },
      {
        from: 'gpt',
        value: 'raw completion',
        predictionParsed: [
          {
            action_type: 'finished',
            action_inputs: { content: 'Your notes are organized.' },
            thought: '',
            reflection: null,
          },
        ],
      },
    ];
    const turns = conversationTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      role: 'assistant',
      actions: ['Click'],
      answers: ['Your notes are organized.'],
    });
    expect(JSON.stringify(turns)).not.toMatch(
      /private|raw|old-image|start_box/,
    );
  });

  it('preserves plain replies, separates user turns and ignores empty records', () => {
    const turns = conversationTurns([
      { from: 'human', value: '<image>' },
      { from: 'gpt', value: '' },
      { from: 'human', value: 'Hello' },
      { from: 'gpt', value: 'Hello back' },
      { from: 'human', value: 'Next question' },
      { from: 'gpt', value: 'Next answer' },
    ]);
    expect(turns.map((turn) => turn.role)).toEqual([
      'human',
      'assistant',
      'human',
      'assistant',
    ]);
    expect(turns[1].answers).toEqual(['Hello back']);
    expect(turns[3].answers).toEqual(['Next answer']);
  });
});
