import type { FsNode } from '@/persistence/db';
import type { AppId } from './appIds';
import { APP_META } from './appMeta';
import { useWindows } from './windows';

/**
 * Dateizuordnungen: Welche App öffnet welchen Dateityp? Die erste passende App ist die
 * Standard-App (Doppelklick), alle passenden erscheinen unter „Öffnen mit“.
 */

type Kind = 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'zip';

const EXT: Record<Kind, RegExp> = {
  text: /\.(txt|md|markdown|log|json|csv|tsv|rpy|rpym|py|js|ts|css|html?|xml|ya?ml|toml|ini|cfg|conf|sh|bat|srt|vtt|tex)$/i,
  image: /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i,
  pdf: /\.pdf$/i,
  audio: /\.(mp3|ogg|oga|opus|wav|m4a|aac|flac)$/i,
  video: /\.(mp4|m4v|webm|mov|ogv)$/i,
  zip: /\.zip$/i,
};

export function fileKind(node: Pick<FsNode, 'name' | 'mime'>): Kind | null {
  const mime = node.mime || '';
  if (EXT.zip.test(node.name)) return 'zip';
  if (EXT.pdf.test(node.name) || mime === 'application/pdf') return 'pdf';
  if (EXT.image.test(node.name) || mime.startsWith('image/')) return 'image';
  if (EXT.audio.test(node.name) || mime.startsWith('audio/')) return 'audio';
  if (EXT.video.test(node.name) || mime.startsWith('video/')) return 'video';
  if (EXT.text.test(node.name) || mime.startsWith('text/') || mime === 'application/json') return 'text';
  return null;
}

const OPENERS: Record<Kind, AppId[]> = {
  text: ['editor'],
  image: ['viewer'],
  pdf: ['viewer'],
  audio: ['media'],
  video: ['media'],
  zip: ['installer'],
};

/** Apps, die diese Datei öffnen können (erste = Standard). Unbekannte Dateien: Texteditor als Option. */
export function openersFor(node: Pick<FsNode, 'name' | 'mime' | 'kind'>): AppId[] {
  if (node.kind !== 'file') return [];
  const kind = fileKind(node);
  return kind ? OPENERS[kind] : [];
}

export function defaultOpener(node: Pick<FsNode, 'name' | 'mime' | 'kind'>): AppId | null {
  return openersFor(node)[0] ?? null;
}

/** Öffnet eine Datei in einer App. Liefert false, wenn es keine passende App gibt. */
export function openFileWith(node: Pick<FsNode, 'id' | 'name' | 'mime' | 'kind'>, appId?: AppId): boolean {
  const target = appId ?? defaultOpener(node);
  if (!target) return false;
  const ws = useWindows.getState();
  if (target === 'installer') {
    ws.open('installer', { fileNodeId: node.id, nonce: Date.now() });
    return true;
  }
  // Ist die Datei schon offen, Fenster nach vorn holen.
  const existing = Object.values(ws.windows).find((w) => w.appId === target && w.payload?.fileId === node.id);
  if (existing) {
    ws.focus(existing.id);
    return true;
  }
  if (APP_META[target].singleInstance) {
    const running = Object.values(ws.windows).find((w) => w.appId === target);
    if (running) {
      ws.setPayload(running.id, { fileId: node.id, nonce: Date.now() });
      ws.focus(running.id);
      return true;
    }
  }
  ws.open(target, { fileId: node.id, nonce: Date.now() }, { newInstance: true });
  return true;
}
