/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Key, keyboard } from '@computer-use/nut-js';
import {
  type ScreenshotOutput,
  type ExecuteParams,
  type ExecuteOutput,
} from '@ui-tars/sdk/core';
import { NutJSOperator } from '@ui-tars/operator-nut-js';
import { clipboard } from 'electron';
import { desktopCapturer, screen } from 'electron';
import sharp from 'sharp';

import * as env from '@main/env';
import { logger } from '@main/logger';
import { sleep } from '@ui-tars/shared/utils';
import { getScreenSize } from '@main/utils/screen';
import { withoutAssistantOverlays } from '@main/window/capture';
import {
  assertGazeClick,
  gazeExecutionRect,
  type GazeExecutionReference,
} from '../cyrvis/gaze/execution';

export class NutJSElectronOperator extends NutJSOperator {
  private gazePending: boolean;
  constructor(private readonly gazeReference?: GazeExecutionReference) {
    super();
    this.gazePending = !!gazeReference;
  }
  static MANUAL = {
    ACTION_SPACES: [
      `click(start_box='[x1, y1, x2, y2]')`,
      `left_double(start_box='[x1, y1, x2, y2]')`,
      `right_single(start_box='[x1, y1, x2, y2]')`,
      `drag(start_box='[x1, y1, x2, y2]', end_box='[x3, y3, x4, y4]')`,
      `hotkey(key='')`,
      `type(content='') #If you want to submit your input, use "\\n" at the end of \`content\`.`,
      `scroll(start_box='[x1, y1, x2, y2]', direction='down or up or right or left')`,
      `wait() #Sleep for 5s and take a screenshot to check for any changes.`,
      `finished()`,
      `call_user() # Submit the task and call the user when the task is unsolvable, or when you need the user's help.`,
    ],
  };

  public async screenshot(): Promise<ScreenshotOutput> {
    return withoutAssistantOverlays(() => this.captureDesktop());
  }

  private async captureDesktop(): Promise<ScreenshotOutput> {
    const {
      physicalSize,
      logicalSize,
      scaleFactor,
      id: primaryDisplayId,
    } = getScreenSize(); // Logical = Physical / scaleX

    logger.info(
      '[screenshot] [primaryDisplay]',
      'logicalSize:',
      logicalSize,
      'scaleFactor:',
      scaleFactor,
    );

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(logicalSize.width),
        height: Math.round(logicalSize.height),
      },
    });
    const primarySource =
      sources.find(
        (source) => source.display_id === primaryDisplayId.toString(),
      ) || sources[0];

    if (!primarySource) {
      logger.error('[screenshot] Primary display source not found', {
        primaryDisplayId,
        availableSources: sources.map((s) => s.display_id),
      });
      // fallback to default screenshot
      return await super.screenshot();
    }

    const screenshot = primarySource.thumbnail;

    const resized = screenshot.resize({
      width: physicalSize.width,
      height: physicalSize.height,
    });

    let image = resized.toJPEG(75);
    if (this.gazePending && this.gazeReference) {
      const current = screen.getPrimaryDisplay().bounds;
      if (
        Object.keys(current).some(
          (key) =>
            current[key as keyof typeof current] !==
            this.gazeReference!.displayBounds[key as keyof typeof current],
        )
      )
        throw new Error('显示器位置或尺寸已变化，请重新锁定注视对象。');
      const r = gazeExecutionRect(
        this.gazeReference,
        physicalSize.width,
        physicalSize.height,
      );
      const overlay = Buffer.from(
        `<svg width="${physicalSize.width}" height="${physicalSize.height}"><rect x="${r.x + 2}" y="${r.y + 2}" width="${Math.max(1, r.width - 4)}" height="${Math.max(1, r.height - 4)}" fill="none" stroke="#ff00cc" stroke-width="4"/></svg>`,
      );
      image = await sharp(image)
        .composite([{ input: overlay }])
        .jpeg({ quality: 75 })
        .toBuffer();
    }
    return {
      base64: image.toString('base64'),
      scaleFactor,
    };
  }

  async execute(params: ExecuteParams): Promise<ExecuteOutput> {
    const { action_type, action_inputs } = params.parsedPrediction;
    const initialGazeClick =
      this.gazePending &&
      this.gazeReference &&
      ['click', 'left_double', 'right_single'].includes(action_type);
    if (initialGazeClick) {
      const { physicalSize } = getScreenSize();
      assertGazeClick(
        this.gazeReference!,
        String(action_inputs.start_box),
        physicalSize.width,
        physicalSize.height,
      );
    }

    if (action_type === 'type' && env.isWindows && action_inputs?.content) {
      const content = action_inputs.content?.trim();

      logger.info('[device] type', content);
      const stripContent = content.replace(/\\n$/, '').replace(/\n$/, '');
      const originalClipboard = clipboard.readText();
      clipboard.writeText(stripContent);
      await keyboard.pressKey(Key.LeftControl, Key.V);
      await sleep(50);
      await keyboard.releaseKey(Key.LeftControl, Key.V);
      await sleep(50);
      clipboard.writeText(originalClipboard);
    } else {
      const pointerAction = [
        'click',
        'left_double',
        'right_single',
        'drag',
      ].includes(action_type);
      const result = await (pointerAction
        ? withoutAssistantOverlays(() => super.execute(params))
        : super.execute(params));
      if (initialGazeClick) this.gazePending = false;
      return result;
    }
  }
}
