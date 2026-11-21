/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Conversation } from '@ui-tars/shared/types';
import type { GazeChatTurn } from '@shared/cyrvis';

export interface ConversationWithSoM extends Conversation {
  gazeTurn?: GazeChatTurn;
  screenshotBase64WithElementMarker?: string;
}
