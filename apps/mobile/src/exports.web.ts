export async function exportMedia(
  data: string,
  name: string,
  format: 'png' | 'mp4',
  _destination: 'share' | 'photos',
) {
  const anchor = document.createElement('a');
  anchor.href = data;
  anchor.download = `${name}.${format}`;
  anchor.click();
}
