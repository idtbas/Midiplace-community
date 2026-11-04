import { File, FileArchive, FileAudio, FileImage, FileText, FileVideo } from 'lucide-react';
import type { FsNode } from '@/persistence/db';
import { isImageFile, isTextFile, isZipFile } from '@/persistence/fs';

export function FileIcon({ node, size }: { node: Pick<FsNode, 'kind' | 'name' | 'mime'>; size: number }) {
  if (node.kind === 'folder') {
    return <img src="/icons/apps/files.png" alt="" draggable={false} style={{ width: size, height: size }} className="shrink-0" />;
  }
  const iconSize = Math.round(size * 0.78);
  const Icon = isZipFile(node)
    ? FileArchive
    : isImageFile(node)
      ? FileImage
      : isTextFile(node)
        ? FileText
        : node.mime.startsWith('audio/')
          ? FileAudio
          : node.mime.startsWith('video/')
            ? FileVideo
            : File;
  return (
    <span className="flex shrink-0 items-center justify-center text-fg-muted" style={{ width: size, height: size }}>
      <Icon size={iconSize} strokeWidth={1.4} />
    </span>
  );
}
