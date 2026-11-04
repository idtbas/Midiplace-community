import { useEffect, useState } from 'react';
import { Download, PackageOpen } from 'lucide-react';
import { t } from '@/i18n';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { FsNode } from '@/persistence/db';
import { isImageFile, isTextFile, isZipFile, kindLabel, readBlob } from '@/persistence/fs';
import { Button } from '@/ui/Button';
import { FileIcon } from './FileIcon';

const TEXT_PREVIEW_BYTES = 64 * 1024;

export function FilePreview({ node, onExport, onInstall }: { node: FsNode | null; onExport: () => void; onInstall: () => void }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    setImageUrl(null);
    setText(null);
    if (!node || node.kind !== 'file') return undefined;
    let url: string | null = null;
    let cancelled = false;
    void readBlob(node.id).then(async (blob) => {
      if (!blob || cancelled) return;
      if (isImageFile(node)) {
        url = URL.createObjectURL(blob);
        setImageUrl(url);
      } else if (isTextFile(node)) {
        const content = await blob.slice(0, TEXT_PREVIEW_BYTES).text();
        if (!cancelled) setText(content + (blob.size > TEXT_PREVIEW_BYTES ? '\n…' : ''));
      }
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [node]);

  if (!node) {
    return <div className="flex h-full items-center justify-center p-6 text-center text-sm text-fg-subtle">{t.files.noPreview}</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-[180px] flex-1 items-center justify-center overflow-hidden border-b border-line-soft bg-surface-0 p-3">
        {imageUrl ? (
          <img src={imageUrl} alt={node.name} className="max-h-full max-w-full rounded-sm object-contain" />
        ) : text !== null ? (
          <pre className="scroll-area selectable h-full w-full whitespace-pre-wrap break-words font-mono text-xs text-fg-muted">{text}</pre>
        ) : (
          <FileIcon node={node} size={72} />
        )}
      </div>
      <div className="p-3">
        <div className="selectable break-words text-base font-semibold">{node.name}</div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-fg-subtle">{t.files.columns.kind}</dt>
          <dd className="text-fg-muted">{kindLabel(node)}</dd>
          {node.kind === 'file' ? (
            <>
              <dt className="text-fg-subtle">{t.files.columns.size}</dt>
              <dd className="tabular text-fg-muted">{formatBytes(node.size)}</dd>
            </>
          ) : null}
          <dt className="text-fg-subtle">{t.files.columns.modified}</dt>
          <dd className="text-fg-muted">{formatDateTime(node.modifiedAt)}</dd>
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" icon={Download} onClick={onExport}>
            {t.files.export}
          </Button>
          {isZipFile(node) ? (
            <Button size="sm" icon={PackageOpen} onClick={onInstall}>
              {t.files.openInInstaller}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
