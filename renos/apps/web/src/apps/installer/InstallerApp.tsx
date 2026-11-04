import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleAlert, CircleCheck, CircleX, FileArchive, Info, Library, Play, RotateCcw, ServerOff, UploadCloud } from 'lucide-react';
import type { AnalysisIssue, Game, InstallJob, UploadInfo } from '@renos/shared';
import { t } from '@/i18n';
import { cn } from '@/lib/cn';
import { pickFiles } from '@/lib/download';
import { formatBytes } from '@/lib/format';
import { ApiError, api, errorMessage, uploadArchive } from '@/api/client';
import { useServer } from '@/api/server';
import { getNode, readBlob } from '@/persistence/fs';
import { launchGame, openApp } from '@/system/actions';
import type { AppProps } from '@/system/apps';
import { notify } from '@/system/notifications';
import { Button } from '@/ui/Button';
import { Notice, ProgressBar, Spinner } from '@/ui/Feedback';
import { Field, TextInput } from '@/ui/Form';
import { LoginForm } from '@/ui/LoginForm';

type Phase =
  | { name: 'select'; notice?: string }
  | { name: 'uploading'; fileName: string; loaded: number; total: number; abort: () => void }
  | { name: 'analysed'; upload: UploadInfo; title: string }
  | { name: 'installing'; upload: UploadInfo; job: InstallJob }
  | { name: 'done'; game: Game | null; title: string }
  | { name: 'error'; title: string; message: string; upload?: UploadInfo };

const STEPS = [t.installer.stepUpload, t.installer.stepCheck, t.installer.stepInstall];

function stepIndex(phase: Phase): number {
  if (phase.name === 'select' || phase.name === 'uploading') return 0;
  if (phase.name === 'analysed') return 1;
  if (phase.name === 'error') return phase.upload ? 2 : 1;
  return 2;
}

export default function InstallerApp({ payload }: AppProps) {
  const server = useServer();
  const isOwner = server.session?.authenticated ?? false;
  const maxUpload = server.health?.limits.maxUploadBytes ?? 0;
  const [phase, setPhase] = useState<Phase>({ name: 'select' });
  const [dragging, setDragging] = useState(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Laufenden Upload abbrechen, wenn das Fenster geschlossen wird.
  useEffect(() => () => {
    if (phaseRef.current.name === 'uploading') phaseRef.current.abort();
  }, []);

  const start = useCallback(
    (file: Blob, fileName: string) => {
      if (!/\.zip$/i.test(fileName)) return setPhase({ name: 'select', notice: t.installer.notZip });
      if (file.size === 0) return setPhase({ name: 'select', notice: t.installer.emptyFile });
      if (maxUpload && file.size > maxUpload) return setPhase({ name: 'select', notice: t.installer.tooLarge(formatBytes(maxUpload)) });
      const handle = uploadArchive(file, fileName, (loaded, total) => {
        setPhase((p) => (p.name === 'uploading' ? { ...p, loaded, total } : p));
      });
      setPhase({ name: 'uploading', fileName, loaded: 0, total: file.size, abort: handle.abort });
      handle.promise.then(
        (upload) => setPhase({ name: 'analysed', upload, title: upload.analysis.detectedTitle ?? fileName.replace(/\.zip$/i, '') }),
        (error: unknown) => {
          if (error instanceof ApiError && error.code === 'aborted') setPhase({ name: 'select', notice: t.installer.uploadCancelled });
          else setPhase({ name: 'error', title: t.installer.failedTitle, message: errorMessage(error) });
        },
      );
    },
    [maxUpload],
  );

  // Übergabe aus Files („Mit Installer öffnen“).
  const handledNonce = useRef<unknown>(null);
  useEffect(() => {
    const nodeId = payload?.fileNodeId;
    if (typeof nodeId !== 'string' || handledNonce.current === payload?.nonce || !isOwner || phase.name !== 'select') return;
    handledNonce.current = payload?.nonce;
    void (async () => {
      const node = await getNode(nodeId);
      const blob = node ? await readBlob(nodeId) : undefined;
      if (!node || !blob) return;
      notify({ kind: 'info', title: t.installer.fromFiles(node.name), transient: true });
      start(blob, node.name);
    })();
  }, [payload, isOwner, phase.name, start]);

  const choose = async () => {
    const [file] = await pickFiles({ accept: '.zip,application/zip,application/x-zip-compressed' });
    if (file) start(file, file.name);
  };

  const install = async (upload: UploadInfo, title: string) => {
    try {
      const { job } = await api.install(upload.id, title);
      setPhase({ name: 'installing', upload, job });
      let current = job;
      while (current.state !== 'done' && current.state !== 'failed') {
        await new Promise((r) => window.setTimeout(r, 350));
        current = (await api.job(job.id)).job;
        setPhase({ name: 'installing', upload, job: current });
      }
      if (current.state === 'failed') {
        setPhase({ name: 'error', title: t.installer.failedTitle, message: current.error?.message ?? t.errors.api.install_failed, upload });
        return;
      }
      let game: Game | null = null;
      if (current.gameId) {
        game = (await api.game(current.gameId)).game;
        server.upsertGame(game);
        void server.loadStorage();
      }
      setPhase({ name: 'done', game, title });
      notify({ kind: 'success', title: t.installer.doneTitle, message: t.installer.doneText(title) });
    } catch (error) {
      setPhase({ name: 'error', title: t.installer.failedTitle, message: errorMessage(error), upload });
    }
  };

  const discard = async (upload: UploadInfo) => {
    if (upload.analysis.installable) await api.discardUpload(upload.id).catch(() => undefined);
    setPhase({ name: 'select' });
  };

  // ----- Voraussetzungen ---------------------------------------------------------
  let content: React.ReactNode;
  if (server.status === 'offline') {
    content = (
      <div className="flex flex-col items-center py-10 text-center">
        <ServerOff size={32} strokeWidth={1.6} className="text-fg-subtle" />
        <p className="mt-3 text-base text-fg-muted">{t.installer.needsServer}</p>
        <p className="mt-1 text-sm text-fg-subtle">{t.errors.network}</p>
      </div>
    );
  } else if (!server.session) {
    content = (
      <div className="flex justify-center py-12">
        <Spinner size={22} />
      </div>
    );
  } else if (!isOwner) {
    content = (
      <div className="py-6">
        <LoginForm />
      </div>
    );
  } else if (phase.name === 'select') {
    content = (
      <>
        <div
          className={cn(
            'flex flex-col items-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
            dragging ? 'border-accent bg-accent-softer' : 'border-line bg-surface-0/50',
          )}
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
            if (file) start(file, file.name);
          }}
          data-testid="installer-dropzone"
        >
          <UploadCloud size={40} strokeWidth={1.4} className="text-fg-subtle" />
          <Button variant="primary" size="lg" className="mt-5" icon={FileArchive} onClick={() => void choose()} data-testid="installer-choose">
            {t.installer.choose}
          </Button>
          <p className="mt-2 text-base text-fg-muted">{t.installer.drop}</p>
          {maxUpload ? <p className="mt-4 text-sm text-fg-subtle">{t.installer.limits(formatBytes(maxUpload))}</p> : null}
        </div>
        {phase.notice ? (
          <Notice kind="warning" className="mt-4">
            {phase.notice}
          </Notice>
        ) : null}
      </>
    );
  } else if (phase.name === 'uploading') {
    const ratio = phase.total ? phase.loaded / phase.total : 0;
    content = (
      <div className="py-8" data-testid="installer-uploading">
        <div className="flex items-center gap-3">
          <FileArchive size={22} className="text-fg-muted" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-medium">{phase.fileName}</div>
            <div className="tabular text-sm text-fg-subtle">
              {ratio >= 1 ? t.installer.analysing : `${t.installer.uploading} ${formatBytes(phase.loaded)} / ${formatBytes(phase.total)}`}
            </div>
          </div>
          <span className="tabular text-base text-fg-muted">{Math.round(ratio * 100)} %</span>
        </div>
        {/* Nach dem Upload prüft der Server das Archiv – dafür gibt es keinen messbaren Fortschritt. */}
        <ProgressBar className="mt-4" value={ratio >= 1 ? null : ratio} label={t.installer.uploading} />
        <div className="mt-6 flex justify-end">
          <Button variant="ghost" onClick={phase.abort} disabled={ratio >= 1}>
            {t.installer.cancelUpload}
          </Button>
        </div>
      </div>
    );
  } else if (phase.name === 'analysed') {
    content = <AnalysisView phase={phase} onTitle={(title) => setPhase({ ...phase, title })} onInstall={() => void install(phase.upload, phase.title)} onDiscard={() => void discard(phase.upload)} />;
  } else if (phase.name === 'installing') {
    const { job } = phase;
    const ratio = job.bytesTotal ? job.bytesWritten / job.bytesTotal : 0;
    content = (
      <div className="py-8" data-testid="installer-installing">
        <div className="flex items-center justify-between text-base">
          <span className="font-medium">{job.state === 'finalizing' ? t.installer.finalizing : t.installer.installing}</span>
          <span className="tabular text-fg-muted">{Math.round(ratio * 100)} %</span>
        </div>
        <ProgressBar className="mt-3" value={job.state === 'queued' ? null : ratio} label={t.installer.installing} />
        <p className="tabular mt-2 text-sm text-fg-subtle">
          {job.filesWritten} / {job.filesTotal} {t.installer.facts.files} · {formatBytes(job.bytesWritten)} / {formatBytes(job.bytesTotal)}
        </p>
      </div>
    );
  } else if (phase.name === 'done') {
    content = (
      <div className="flex flex-col items-center py-8 text-center" data-testid="installer-done">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success">
          <CheckCircle2 size={30} strokeWidth={1.7} />
        </div>
        <h3 className="mt-4 text-lg font-semibold">{t.installer.doneTitle}</h3>
        <p className="mt-1 text-base text-fg-muted">{t.installer.doneText(phase.game?.title ?? phase.title)}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {phase.game ? (
            <Button variant="primary" icon={Play} onClick={() => void launchGame(phase.game!.id)}>
              {t.installer.playNow}
            </Button>
          ) : null}
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
        <h3 className="mt-4 text-lg font-semibold">{phase.title}</h3>
        <p className="mt-1 max-w-md text-base text-fg-muted">{phase.message}</p>
        <div className="mt-6 flex gap-2">
          {phase.upload?.analysis.installable ? (
            <Button icon={RotateCcw} onClick={() => setPhase({ name: 'analysed', upload: phase.upload!, title: phase.upload!.analysis.detectedTitle ?? '' })}>
              {t.system.retry}
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => (phase.upload ? void discard(phase.upload) : setPhase({ name: 'select' }))}>
            {t.installer.chooseOther}
          </Button>
        </div>
      </div>
    );
  }

  const current = stepIndex(phase);
  return (
    <div className="scroll-area h-full bg-surface-1">
      <div className="mx-auto max-w-[620px] px-8 py-7">
        <div className="flex items-start gap-4">
          <img src="/icons/apps/installer.png" alt="" className="h-12 w-12" draggable={false} />
          <div>
            <h2 className="text-xl font-semibold">{t.installer.title}</h2>
            <p className="mt-1 text-base text-fg-muted">{t.installer.subtitle}</p>
          </div>
        </div>
        {isOwner && server.status !== 'offline' ? (
          <ol className="mt-6 flex items-center gap-2 text-sm" aria-label="Fortschritt">
            {STEPS.map((label, i) => (
              <li key={label} className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold',
                    i < current ? 'bg-success text-[#10151c]' : i === current ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-fg-subtle',
                  )}
                >
                  {i + 1}
                </span>
                <span className={i === current ? 'text-fg' : 'text-fg-subtle'}>{label}</span>
                {i < STEPS.length - 1 ? <span className="mx-1 h-px w-8 bg-line" /> : null}
              </li>
            ))}
          </ol>
        ) : null}
        <div className="mt-6">{content}</div>
      </div>
    </div>
  );
}

function IssueIcon({ issue }: { issue: AnalysisIssue }) {
  if (issue.severity === 'error') return <CircleX size={15} className="mt-0.5 shrink-0 text-danger" />;
  if (issue.severity === 'warning') return <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />;
  return <Info size={15} className="mt-0.5 shrink-0 text-fg-subtle" />;
}

function AnalysisView({
  phase,
  onTitle,
  onInstall,
  onDiscard,
}: {
  phase: Extract<Phase, { name: 'analysed' }>;
  onTitle: (title: string) => void;
  onInstall: () => void;
  onDiscard: () => void;
}) {
  const { analysis } = phase.upload;
  const ok = analysis.installable;
  return (
    <div data-testid="installer-analysis" data-kind={analysis.kind} data-installable={ok}>
      <div className={cn('flex items-start gap-3 rounded-lg border p-4', ok ? 'border-success/30 bg-success-soft' : 'border-warning/30 bg-warning-soft')}>
        {ok ? <CircleCheck size={20} className="mt-0.5 shrink-0 text-success" /> : <CircleAlert size={20} className="mt-0.5 shrink-0 text-warning" />}
        <div>
          <div className="text-base font-semibold text-fg">{t.installer.kind[analysis.kind]}</div>
          <p className="mt-0.5 text-base text-fg-muted">{t.installer.kindText[analysis.kind]}</p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3">
        <div>
          <div className="mb-2 text-sm font-semibold text-fg-muted">{t.installer.resultTitle}</div>
          <ul className="flex flex-col gap-1.5 text-base">
            {analysis.checks.map((check) => (
              <li key={check.id} className="flex items-center gap-2">
                {check.ok ? <CircleCheck size={15} className="text-success" /> : <CircleX size={15} className="text-fg-faint" />}
                <span className={check.ok ? 'text-fg' : 'text-fg-subtle'}>{t.installer.checks[check.id]}</span>
              </li>
            ))}
          </ul>
        </div>
        <dl className="grid grid-cols-[auto_1fr] content-start gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-fg-subtle">{t.installer.facts.files}</dt>
          <dd className="tabular text-fg-muted">{analysis.fileCount}</dd>
          <dt className="text-fg-subtle">{t.installer.facts.packed}</dt>
          <dd className="tabular text-fg-muted">{formatBytes(analysis.compressedBytes)}</dd>
          <dt className="text-fg-subtle">{t.installer.facts.unpacked}</dt>
          <dd className="tabular text-fg-muted">{formatBytes(analysis.uncompressedBytes)}</dd>
          {analysis.rootPrefix ? (
            <>
              <dt className="text-fg-subtle">{t.installer.facts.folder}</dt>
              <dd className="truncate text-fg-muted">{analysis.rootPrefix}</dd>
            </>
          ) : null}
          {analysis.detectedTitle ? (
            <>
              <dt className="text-fg-subtle">{t.installer.facts.title}</dt>
              <dd className="truncate text-fg-muted">{analysis.detectedTitle}</dd>
            </>
          ) : null}
        </dl>
      </div>

      {analysis.issues.length ? (
        <ul className="mt-5 flex flex-col gap-2 rounded-lg border border-line-soft bg-surface-0/60 p-3 text-sm">
          {analysis.issues.map((issue, i) => (
            <li key={`${issue.code}-${i}`} className="flex gap-2">
              <IssueIcon issue={issue} />
              <span className="text-fg-muted">
                {t.installer.issues[issue.code]}
                {issue.path ? <code className="selectable ml-1.5 break-all font-mono text-xs text-fg-subtle">{issue.path}</code> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {ok ? (
        <div className="mt-6">
          <Field label={t.installer.titleLabel} htmlFor="installer-title">
            <TextInput id="installer-title" value={phase.title} maxLength={120} onChange={(e) => onTitle(e.target.value)} />
          </Field>
        </div>
      ) : null}

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onDiscard}>
          {ok ? t.installer.discard : t.installer.chooseOther}
        </Button>
        {ok ? (
          <Button variant="primary" onClick={onInstall} disabled={!phase.title.trim()} data-testid="installer-install">
            {t.installer.install}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
