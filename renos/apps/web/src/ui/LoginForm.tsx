import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { t } from '@/i18n';
import { errorMessage } from '@/api/client';
import { useServer } from '@/api/server';
import { notify } from '@/system/notifications';
import { Button } from './Button';
import { Notice } from './Feedback';
import { TextInput } from './Form';

/** Anmeldung des Owners am RenOS-Server (Passwort wird nie lokal gespeichert). */
export function LoginForm({ readOnly = false, compact = false }: { readOnly?: boolean; compact?: boolean }) {
  const login = useServer((s) => s.login);
  const ownerConfigured = useServer((s) => s.health?.ownerConfigured ?? true);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!ownerConfigured) return <Notice kind="warning">{t.auth.notConfigured}</Notice>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await login(password);
      setPassword('');
      notify({ kind: 'success', title: t.auth.success, transient: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className={compact ? 'flex flex-col gap-3' : 'mx-auto flex w-full max-w-sm flex-col gap-3'} data-testid="login-form">
      {compact ? null : (
        <div className="mb-2 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-surface-2 text-fg-muted">
            <KeyRound size={22} strokeWidth={1.7} />
          </div>
          <h3 className="text-lg font-semibold">{t.auth.title}</h3>
          <p className="mt-1 text-base text-fg-muted">{readOnly ? t.auth.descriptionRead : t.auth.description}</p>
        </div>
      )}
      <TextInput
        type="password"
        aria-label={t.auth.password}
        placeholder={t.auth.password}
        value={password}
        invalid={Boolean(error)}
        onChange={(e) => {
          setPassword(e.target.value);
          setError(null);
        }}
        autoComplete="current-password"
      />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button type="submit" variant="primary" loading={busy} disabled={!password}>
        {t.auth.submit}
      </Button>
    </form>
  );
}
