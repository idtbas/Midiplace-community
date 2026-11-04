import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleX, FileArchive, HardDrive, Library, Play, UploadCloud } from 'lucide-react';
import type { ArchiveAnalysis, Game } from '@renos/shared';
import { t } from '@/i18n';
import { cn } from '@/lib/cn';
import { pickFiles } from '@/lib/download';
import { formatBytes } from '@/lib/format';
import { ApiError, errorMessage } from '@/api/client';
import { useServer } from '@/api/server';
import { asset } from '@/config';
import { gameHostUrl } from '@/games/gameHost';
import { analyzeLocalArchive, freeLocalBytes, installConvertedGame, installLocalGame, runtimeFor, type ConvertPhase } from '@/games/local/localGames';
import type { RuntimeSummary } from '@/games/local/runtimes';
import { opfsSupported } from '@/games/local/opfs';
import { getNode, readBlob } from '@/persistence/fs';
import { launchGame, openApp } from '@/system/actions';
import type { AppProps } from '@/system/apps';
import { notify } from '@/system/notifications';
import { useSettings } from '@/system/settings';
import { Button } from '@/ui/Button';
import { Notice, ProgressBar, Spinner } from '@/ui/Feedback';
import { AnalysisView } from './AnalysisView';

type Phase =
  | { name: 'select'; notice?: string }
  | { name: 'analysing'; fileName: string }
  | {
      name: 'analysed';
      file: File;
      analysis: ArchiveAnalysis;
      title: string;
      free: number | null;
      /** Nur bei Desktop-Builds: passende Ren'Py-Laufzeit (undefined = wird noch geprüft). */
      runtime?: (RuntimeSummary & { installed: boolean }) | null;
    }
  | { name: 'installing'; file: File; analysis: ArchiveAnalysis; bytes: number; files: number; total: number; step: ConvertPhase | 'copy'; cancel: () => void }
  | { name: 'done'; game: Game; note?: string; warning?: string }
  | { name: 'error'; message: string };

const STEPS = [t.installer.stepCheck, t.installer.stepInstall];

/**
 * Installation direkt auf diesem Gerät (lokaler Modus): Das Archiv wird nicht hochgeladen, sondern
 * im Hintergrund geprüft und in den Speicher von RenOS entpackt.
 */
export function LocalInstaller({ payload }: AppProps) {
  const upsertGame = useServer((s) => s.upsertGame);
  const loadStorage = useServer((s) => s.loadStorage);
  const [phase, setPhase] = useState<Phase>({ name: 'select' });
  const [dragging, setDragging] = useState(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => () => {
    if (phaseRef.current.name === 'installing') phaseRef.current.cancel();
  }, []);

  const start = useCallback(async (file: File) => {
    if (!/\.zip$/i.test(file.name)) return setPhase({ name: 'select', notice: t.installer.notZip });
    if (file.size === 0) return setPhase({ name: 'select', notice: t.installer.emptyFile });
    setPhase({ name: 'analysing', fileName: file.name });
    try {
      const [analysis, free] = await Promise.all([analyzeLocalArchive(file), freeLocalBytes()]);
      const title = analysis.detectedTitle ?? file.name.replace(/\.zip$/i, '');
      setPhase({ name: 'analysed', file, analysis, title, free, runtime: analysis.conversion ? undefined : null });
      if (analysis.conversion) {
        const runtime = await runtimeFor(analysis);
        setPhase((p) => (p.name === 'analysed' && p.file === file ? { ...p, runtime } : p));
      }
    } catch (error) {
      setPhase({ name: 'error', message: errorMessage(error) });
    }
  }, []);

  // Übergabe aus Files („Mit Installer öffnen“).
  const handledNonce = useRef<unknown>(null);
  useEffect(() => {
    const nodeId = payload?.fileNodeId;
    if (typeof nodeId !== 'string' || handledNonce.current === payload?.nonce || phase.name !== 'select') return;
    handledNonce.current = payload?.nonce;
    void (async () => {
      const node = await getNode(nodeId);
      const blob = node ? await readBlob(nodeId) : undefined;
      if (!node || !blob) return;
      notify({ kind: 'info', title: t.installer.fromFiles(node.name), transient: true });
      await start(new File([blob], node.name, { type: 'application/zip' }));
    })();
  }, [payload, phase.name, start]);

  const failed = (error: unknown) => {
    if (error instanceof ApiError && error.code === 'aborted') setPhase({ name: 'select', notice: t.installer.installCancelled });
    else setPhase({ name: 'error', message: errorMessage(error) });
  };

  const install = (file: File, analysis: ArchiveAnalysis, title: string) => {
    const hostUrl = gameHostUrl(useSettings.getState().gameHostUrl) ?? '';
    if (analysis.conversion) {
      const handle = installConvertedGame(file, analysis, title, hostUrl, (step, done, total) =>
        setPhase((p) => (p.name === 'installing' ? { ...p, step, bytes: done, total: total || 1 } : p)),
      );
      setPhase({ name: 'installing', file, analysis, bytes: 0, files: 0, total: analysis.conversion.gameBytes || 1, step: 'convert', cancel: handle.cancel });
      handle.promise.then(({ game, report }) => {
        upsertGame(game);
        void loadStorage();
        setPhase({
          name: 'done',
          game,
          note: t.installer.convert.done(report.remoteFiles),
          warning: report.unsupportedArchives.length ? t.installer.convert.unsupportedArchives(report.unsupportedArchives.join(', ')) : undefined,
        });
        notify({ kind: 'success', title: t.installer.doneTitle, message: t.installer.doneText(game.title) });
      }, failed);
      return;
    }
    const handle = installLocalGame(file, analysis, title, hostUrl, (bytes, files) => setPhase((p) => (p.name === 'installing' ? { ...p, bytes, files } : p)));
    setPhase({ name: 'installing', file, analysis, bytes: 0, files: 0, total: analysis.uncompressedBytes || 1, step: 'copy', cancel: handle.cancel });
    handle.promise.then(
      (game) => {
        upsertGame(game);
        void loadStorage();
        setPhase({ name: 'done', game });
        notify({ kind: 'success', title: t.installer.doneTitle, message: t.installer.doneText(game.title) });
      },
      failed,
    );
  };

  let content: React.ReactNode;
  if (!opfsSupported()) {
    content = <Notice kind="error">{t.installer.localUnsupported}</Notice>;
  } else if (phase.name === 'select') {
    content = (
      <>
        <div
          className={cn('flex flex-col items-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors', dragging ? 'border-accent bg-accent-softer' : 'border-line bg-surface-0/50')}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) void start(file);
          }}
          data-testid="installer-dropzone"
        >
          <UploadCloud size={40} strokeWidth={1.4} className="text-fg-subtle" />
          <Button
            variant="primary"
            size="lg"
            className="mt-5"
            icon={FileArchive}
            data-testid="installer-choose"
            onClick={() =>
              void pickFiles({ accept: '.zip,application/zip,application/x-zip-compressed' }).then(([file]) => {
                if (file) void start(file);
              })
            }
          >
            {t.installer.choose}
          </Button>
          <p className="mt-2 text-base text-fg-muted">{t.installer.drop}</p>
          <p className="mt-4 flex items-center gap-1.5 text-sm text-fg-subtle">
            <HardDrive size={14} /> {t.installer.localHint}
          </p>
        </div>
        {phase.notice ? (
          <Notice kind="warning" className="mt-4">
            {phase.notice}
          </Notice>
        ) : null}
      </>
    );
  } else if (phase.name === 'analysing') {
    content = (
      <div className="flex items-center gap-3 py-10" data-testid="installer-analysing">
        <Spinner size={20} />
        <div>
          <div className="text-base font-medium">{phase.fileName}</div>
          <div className="text-sm text-fg-subtle">{t.installer.analysing}</div>
        </div>
      </div>
    );
  } else if (phase.name === 'analysed') {
    const conversion = phase.analysis.conversion;
    const runtime = phase.runtime;
    const needed = phase.analysis.uncompressedBytes + (conversion && runtime && !runtime.installed ? runtime.totalBytes : 0);
    const enough = phase.free === null || phase.free >= needed + 128 * 1024 * 1024;
    const runtimeBlocked = Boolean(conversion) && !runtime;
    const newer = conversion?.engineVersion && runtime && conversion.engineVersion.localeCompare(runtime.version, 'en', { numeric: true }) > 0;
    content = (
      <AnalysisView
        analysis={phase.analysis}
        title={phase.title}
        onTitle={(title) => setPhase({ ...phase, title })}
        onInstall={() => install(phase.file, phase.analysis, phase.title)}
        onDiscard={() => setPhase({ name: 'select' })}
        installDisabled={!enough || runtimeBlocked}
        conversionFacts={
          conversion ? (
            <>
              <dt className="text-fg-subtle">{t.installer.convert.runtime}</dt>
              <dd className="text-fg-muted" data-testid="installer-runtime">
                {runtime === undefined
                  ? t.installer.convert.runtimeChecking
                  : runtime === null
                    ? '–'
                    : runtime.installed
                      ? t.installer.convert.runtimeReady(runtime.version)
                      : t.installer.convert.runtimeDownload(runtime.version, formatBytes(runtime.totalBytes))}
              </dd>
            </>
          ) : null
        }
      >
        {conversion && runtime === null ? (
          <Notice kind="error" className="mt-5 text-sm">
            {t.installer.convert.runtimeMissing}
          </Notice>
        ) : null}
        {newer && runtime ? (
          <Notice kind="warning" className="mt-5 text-sm">
            {t.installer.convert.newerEngine(conversion!.engineVersion!, runtime.version)}
          </Notice>
        ) : null}
        {phase.analysis.installable ? (
          <Notice kind={enough ? 'info' : 'error'} className="mt-5 text-sm" >
            <span data-testid="installer-space">
              {t.installer.spaceNeeded(formatBytes(needed))}
              {phase.free !== null ? ` · ${t.installer.spaceFree(formatBytes(phase.free))}` : ''}
              {enough ? '' : ` – ${t.installer.spaceMissing}`}
            </span>
          </Notice>
        ) : null}
      </AnalysisView>
    );
  } else if (phase.name === 'installing') {
    const ratio = Math.min(phase.bytes / (phase.total || 1), 1);
    const label =
      phase.step === 'runtime'
        ? t.installer.convert.stepRuntime
        : phase.step === 'scan'
          ? t.installer.convert.stepScan
          : phase.step === 'convert'
            ? t.installer.convert.stepConvert
            : t.installer.installing;
    content = (
      <div className="py-8" data-testid="installer-installing" data-step={phase.step}>
        <div className="flex items-center justify-between text-base">
          <span className="font-medium">{label}</span>
          <span className="tabular text-fg-muted">{Math.round(ratio * 100)} %</span>
        </div>
        <ProgressBar className="mt-3" value={ratio} label={label} />
        <p className="tabular mt-2 text-sm text-fg-subtle">
          {phase.step === 'copy' ? `${phase.files} / ${phase.analysis.fileCount} ${t.installer.facts.files} · ` : ''}
          {phase.step === 'scan' ? `${phase.bytes} / ${phase.total} ${t.installer.facts.files}` : `${formatBytes(phase.bytes)} / ${formatBytes(phase.total)}`}
        </p>
        <p className="mt-2 text-sm text-fg-subtle">{t.installer.keepOpen}</p>
        <div className="mt-6 flex justify-end">
          <Button variant="ghost" onClick={phase.cancel}>
            {t.system.cancel}
          </Button>
        </div>
      </div>
    );
  } else if (phase.name === 'done') {
    content = (
      <div className="flex flex-col items-center py-8 text-center" data-testid="installer-done">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success">
          <CheckCircle2 size={30} strokeWidth={1.7} />
        </div>
        <h3 className="mt-4 text-lg font-semibold">{t.installer.doneTitle}</h3>
        <p className="mt-1 text-base text-fg-muted">{t.installer.doneText(phase.game.title)}</p>
        {phase.note ? <p className="mt-2 max-w-md text-sm text-fg-subtle" data-testid="installer-note">{phase.note}</p> : null}
        {phase.warning ? (
          <Notice kind="warning" className="mt-3 max-w-md text-left text-sm">
            {phase.warning}
          </Notice>
        ) : null}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button variant="primary" icon={Play} onClick={() => void launchGame(phase.game.id)}>
            {t.installer.playNow}
          </Button>
          <Button icon={Library} onClick={() => openApp('library')}>
            {t.installer.openLibrary}
          </Button>
          <Button variant="ghost" onClick={() => setPhase({ name: 'select' })}>
            {t.installer.installAnother}
          </Button>
        </div>
      </div>
    );
  } else {
    content = (
      <div className="flex flex-col items-center py-8 text-center" role="alert" data-testid="installer-error">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-danger-soft text-danger">
          <CircleX size={30} strokeWidth={1.7} />
        </div>
        <h3 className="mt-4 text-lg font-semibold">{t.installer.failedTitle}</h3>
        <p className="mt-1 max-w-md text-base text-fg-muted">{phase.message}</p>
        <Button className="mt-6" variant="primary" onClick={() => setPhase({ name: 'select' })}>
          {t.installer.chooseOther}
        </Button>
      </div>
    );
  }

  const current = phase.name === 'select' || phase.name === 'analysing' || phase.name === 'analysed' ? 0 : 1;
  return (
    <div className="scroll-area h-full bg-surface-1">
      <div className="mx-auto max-w-[620px] px-8 py-7">
        <div className="flex items-start gap-4">
          <img src={asset('icons/apps/installer.png')} alt="" className="h-12 w-12" draggable={false} />
          <div>
            <h2 className="text-xl font-semibold">{t.installer.titleLocal}</h2>
            <p className="mt-1 text-base text-fg-muted">{t.installer.subtitleLocal}</p>
          </div>
        </div>
        <ol className="mt-6 flex items-center gap-2 text-sm" aria-label="Fortschritt">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              <span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold', i < current || phase.name === 'done' ? 'bg-success text-[#10151c]' : i === current ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-fg-subtle')}>
                {i + 1}
              </span>
              <span className={i === current ? 'text-fg' : 'text-fg-subtle'}>{label}</span>
              {i < STEPS.length - 1 ? <span className="mx-1 h-px w-8 bg-line" /> : null}
            </li>
          ))}
        </ol>
        <div className="mt-6">{content}</div>
      </div>
    </div>
  );
}
