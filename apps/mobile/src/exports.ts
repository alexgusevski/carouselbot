import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library/legacy';
import { Platform } from 'react-native';
export async function exportMedia(
  data: string,
  name: string,
  format: 'png' | 'mp4',
  destination: 'share' | 'photos',
) {
  const mime = format === 'png' ? 'image/png' : 'video/mp4';
  if (Platform.OS === 'web') {
    const a = document.createElement('a');
    a.href = data;
    a.download = `${name}.${format}`;
    a.click();
    return;
  }
  const file = new File(
    Paths.cache,
    `${name.replace(/[^\w-]/g, '-').slice(0, 80)}-${Date.now()}.${format}`,
  );
  try {
    file.create();
    file.write(data.slice(data.indexOf(',') + 1), { encoding: 'base64' });
    if (destination === 'photos') {
      // Modern Android inserts our own files through MediaStore without reading
      // the photo library. iOS requests add-only access when saving is chosen.
      if (Platform.OS === 'ios' || Number(Platform.Version) < 29) {
        const permission = await MediaLibrary.requestPermissionsAsync(true, [
          format === 'png' ? 'photo' : 'video',
        ]);
        if (!permission.granted) throw new Error('Allow photo access to save your slides.');
      }
      await MediaLibrary.saveToLibraryAsync(file.uri);
    } else {
      if (!(await Sharing.isAvailableAsync()))
        throw new Error('Sharing is not available on this device.');
      await Sharing.shareAsync(file.uri, {
        mimeType: mime,
        UTI: format === 'png' ? 'public.png' : 'public.mpeg-4',
      });
    }
  } finally {
    if (file.exists) file.delete();
  }
}
