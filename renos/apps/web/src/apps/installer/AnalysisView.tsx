import { AlertTriangle, CircleAlert, CircleCheck, CircleX, Info } from 'lucide-react';
import type { AnalysisIssue, ArchiveAnalysis } from '@renos/shared';
import { t } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { Button } from '@/ui/Button';
import { Field, TextInput } from '@/ui/Form';

/** Ergebnis der Archivprüfung – identisch für Server- und lokale Installation. */
function IssueIcon({ issue }: { issue: AnalysisIssue }) {
  if (issue.severity === 'error') return <CircleX size={15} className="mt-0.5 shrink-0 text-danger" />;
  if (issue.severity === 'warning') return <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />;
  return <Info size={15} className="mt-0.5 shrink-0 text-fg-subtle" />;
}

export function AnalysisView({
  analysis,
  title,
  onTitle,
  onInstall,
  onDiscard,
  children,
  installDisabled,
  conversionFacts,
}: {
  analysis: ArchiveAnalysis;
  title: string;
  onTitle: (title: string) => void;
  onInstall: () => void;
  onDiscard: () => void;
  children?: React.ReactNode;
  installDisabled?: boolean;
  /** Zusätzliche Angaben bei der Umwandlung eines Desktop-Builds (z. B. die verwendete Laufzeit). */
  conversionFacts?: React.ReactNode;
}) {
  const ok = analysis.installable;
  const conversion = analysis.conversion ?? null;
  const platforms = conversion?.platforms.map((p) => t.installer.convert.platforms[p]).join(', ');
  const heading = conversion ? (platforms ? t.installer.convert.title(platforms) : t.installer.convert.titleProject) : t.installer.kind[analysis.kind];
  const text = conversion ? (analysis.kind === 'renpy-project' ? `${t.installer.convert.text} ${t.installer.convert.textProject}` : t.installer.convert.text) : t.installer.kindText[analysis.kind];
  return (
    <div data-testid="installer-analysis" data-kind={analysis.kind} data-installable={ok} data-conversion={conversion ? 'true' : undefined}>
      <div className={cn('flex items-start gap-3 rounded-lg border p-4', ok ? 'border-success/30 bg-success-soft' : 'border-warning/30 bg-warning-soft')}>
        {ok ? <CircleCheck size={20} className="mt-0.5 shrink-0 text-success" /> : <CircleAlert size={20} className="mt-0.5 shrink-0 text-warning" />}
        <div>
          <div className="text-base font-semibold text-fg">{heading}</div>
          <p className="mt-0.5 text-base text-fg-muted">{text}</p>
        </div>
      </div>

      {conversion ? (
        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm" data-testid="installer-conversion">
          <dt className="text-fg-subtle">{t.installer.convert.engine}</dt>
          <dd className="text-fg-muted" data-testid="installer-engine">{conversion.engineVersion ?? t.installer.convert.engineUnknown}</dd>
          <dt className="text-fg-subtle">{t.installer.convert.python}</dt>
          <dd className="text-fg-muted">{t.installer.convert.pythonValue(conversion.python)}</dd>
          <dt className="text-fg-subtle">{t.installer.convert.archives}</dt>
          <dd className="tabular text-fg-muted">
            {conversion.archives} · {formatBytes(conversion.archiveBytes)}
          </dd>
          {conversionFacts}
        </dl>
      ) : null}

      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3">
        <div>
          <div className="mb-2 text-sm font-semibold text-fg-muted">{t.installer.resultTitle}</div>
          <ul className="flex flex-col gap-1.5 text-base">
            {analysis.checks.filter((check) => !conversion || ['format', 'size', 'entries', 'paths'].includes(check.id)).map((check) => (
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
            <TextInput id="installer-title" value={title} maxLength={120} onChange={(e) => onTitle(e.target.value)} />
          </Field>
        </div>
      ) : null}

      {children}

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onDiscard}>
          {ok ? t.installer.discard : t.installer.chooseOther}
        </Button>
        {ok ? (
          <Button variant="primary" onClick={onInstall} disabled={!title.trim() || installDisabled} data-testid="installer-install">
            {conversion ? t.installer.convert.install : t.installer.install}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
