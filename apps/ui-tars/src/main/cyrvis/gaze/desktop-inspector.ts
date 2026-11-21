import { desktopCapturer, screen } from 'electron';
import { SettingStore } from '@main/store/setting';
import { getDesktopGaze } from './context';
import { objectCrop, GazeInspector } from './inspector';
import { gazeChat } from './chat';
import { withoutAssistantOverlays } from '@main/window/capture';

export const gazeInspector = new GazeInspector({
  onUpdate: (inspection) => gazeChat.observe(inspection),
  getGaze: getDesktopGaze,
  getConfig: () => SettingStore.getStore(),
  fetch: (input, init) => fetch(input, init),
  capture: async (gaze) =>
    withoutAssistantOverlays(async () => {
      const display = screen.getPrimaryDisplay();
      if (display.id !== gaze.displayId)
        throw new Error('主屏幕已改变，请重新校准。');
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: display.size,
      });
      const source = sources.find(
        (item) => item.display_id === String(gaze.displayId),
      );
      if (!source || source.thumbnail.isEmpty())
        throw new Error(
          '无法截取主屏幕，请在系统设置中允许 CYRVIS / Electron 录制屏幕，然后重启应用。',
        );
      // Map against actual screenshot pixels, independent of Retina scaling.
      const { width, height } = source.thumbnail.getSize();
      const crop = objectCrop(gaze, width, height);
      const jpeg = source.thumbnail.crop(crop).toJPEG(80);
      return {
        preview: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
        crop,
      };
    }),
});
