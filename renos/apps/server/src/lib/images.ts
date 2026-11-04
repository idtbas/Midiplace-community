export { detectImageType, type ImageType } from '@renos/shared';

export function mimeForCoverExt(ext: string): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return null;
}
