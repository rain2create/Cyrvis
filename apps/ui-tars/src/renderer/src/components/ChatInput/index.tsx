/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { IMAGE_PLACEHOLDER } from '@ui-tars/shared/constants';
import { StatusEnum } from '@ui-tars/shared/types';

import { useRunAgent } from '@renderer/hooks/useRunAgent';
import { useStore } from '@renderer/hooks/useStore';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { Button } from '@renderer/components/ui/button';
// import { useScreenRecord } from '@renderer/hooks/useScreenRecord';
import { api } from '@renderer/api';

import { Play, ArrowUp, Square, Loader2, MessageCircle } from 'lucide-react';
import { Textarea } from '@renderer/components/ui/textarea';
import { useSessionStore } from '@renderer/store/session';
import { toast } from 'sonner';

import { Operator } from '@main/store/types';

const ChatInput = ({
  operator,
  sessionId,
  onSessionCreated,
  disabled,
  checkBeforeRun,
  voiceConversation = false,
}: {
  operator: Operator;
  sessionId: string;
  onSessionCreated?: (sessionId: string) => void;
  disabled: boolean;
  checkBeforeRun?: () => Promise<boolean>;
  voiceConversation?: boolean;
}) => {
  const { status, instructions: savedInstructions, messages } = useStore();
  const [localInstructions, setLocalInstructions] = useState('');
  const { run, stopAgentRuning } = useRunAgent();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const ownsRun = Boolean(sessionId) && currentSessionId === sessionId;
  const running = ownsRun && status === StatusEnum.RUNNING;

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

  useEffect(() => {
    if (status === StatusEnum.INIT) {
      return;
    }
  }, [status]);

  const getInstantInstructions = () => {
    if (localInstructions?.trim()) {
      return localInstructions;
    }
    if (isCallUser && savedInstructions?.trim()) {
      return savedInstructions;
    }
    return '';
  };

  // console.log('running', 'status', status, running);

  const startRun = async () => {
    if (disabled || submitLock.current || running) return;
    const instructions = getInstantInstructions();
    if (!instructions.trim()) return;
    submitLock.current = true;
    setSubmitting(true);
    try {
      if (voiceConversation) {
        const result = await window.electron.voice.submitText(instructions);
        if (!result.ok) throw new Error(result.error);
        setLocalInstructions('');
        return;
      }
      if (checkBeforeRun && !(await checkBeforeRun())) return;
      await run(
        instructions,
        sessionId,
        operator,
        () => setLocalInstructions(''),
        onSessionCreated,
      );
    } catch {
      toast.error('Could not send this message. Please try again.');
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) {
      return;
    }

    // `enter` to submit
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.metaKey &&
      getInstantInstructions()
    ) {
      e.preventDefault();

      startRun();
    }
  };

  const isCallUser = useMemo(
    () => ownsRun && status === StatusEnum.CALL_USER,
    [status, ownsRun],
  );

  const lastHumanMessage =
    [...(messages || [])]
      .reverse()
      .find((m) => m?.from === 'human' && m?.value !== IMAGE_PLACEHOLDER)
      ?.value || '';

  const stopRun = async () => {
    await stopAgentRuning(() => {
      setLocalInstructions('');
    });
    await api.clearHistory();
  };

  const renderButton = () => {
    if (running) {
      return (
        <Button
          variant="secondary"
          size="icon"
          className="h-8 w-8"
          aria-label="Stop task"
          disabled={disabled}
          onClick={stopRun}
        >
          <Square className="h-4 w-4" />
        </Button>
      );
    }

    if (isCallUser && !localInstructions) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className="cyrvis-send-button"
                aria-label="Resume task"
                onClick={startRun}
                disabled={!getInstantInstructions() || disabled || submitting}
              >
                <Play className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="whitespace-pre-line">
                Continue after completing the requested action.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }

    return (
      <Button
        variant="secondary"
        size="icon"
        className="cyrvis-send-button"
        aria-label="Send message"
        onClick={startRun}
        disabled={!getInstantInstructions() || disabled || submitting}
      >
        <ArrowUp className="h-4 w-4" />
      </Button>
    );
  };

  return (
    <div className="cyrvis-composer">
      <div className="cyrvis-input-shell">
        <Textarea
          ref={textareaRef}
          placeholder={
            isCallUser && savedInstructions
              ? `${savedInstructions}`
              : running && lastHumanMessage && messages?.length > 1
                ? lastHumanMessage
                : 'What can I do for you today?'
          }
          className="cyrvis-chat-textarea"
          value={localInstructions}
          aria-label="Message"
          disabled={running || disabled || submitting}
          onChange={(e) => setLocalInstructions(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="cyrvis-input-toolbar">
          <span>
            <MessageCircle size={14} aria-hidden="true" /> Chat
          </span>
          <div className="flex items-center gap-2">
            {running && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
            {renderButton()}
          </div>
        </div>
      </div>
      <div className="cyrvis-input-hint">
        <span>Enter to send · Shift + Enter for a new line</span>
        <span>Check important information</span>
      </div>
    </div>
  );
};

export default ChatInput;
