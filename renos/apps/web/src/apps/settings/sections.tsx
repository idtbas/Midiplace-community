import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Download, ImagePlus, LogOut, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { RENOS_VERSION } from '@renos/shared';
import { t } from '@/i18n';
import { cn } from '@/lib/cn';
import { downloadBlob, pickFiles } from '@/lib/download';
import { formatBytes } from '@/lib/format';
import { browserName, displayModeLabel, hasFinePointer, hasHover, isStandalone } from '@/lib/platform';
import { useServer } from '@/api/server';
import { db, kvSet } from '@/persistence/db';
import { createBackup, restoreBackup, wipeLocalData } from '@/persistence/backup';
import { HOME_ID, SPECIAL_FOLDERS, deleteNodes, listChildren, usage } from '@/persistence/fs';
import { requestPersistentStorage, serviceWorkerState } from '@/pwa/register';
import { APP_META } from '@/system/appMeta';
import { APP_IDS, type AppId } from '@/system/appIds';
import { confirmDialog, openDialog } from '@/system/dialogs';
import { notify } from '@/system/notifications';
import { ACCENTS, DEFAULT_SETTINGS, WALLPAPERS, useSettings, type AccentId, type WallpaperId } from '@/system/settings';
import { formatCombo, listShortcuts, subscribeShortcuts } from '@/system/shortcuts';
import { useWindows } from '@/system/windows';
import { showAbout } from '@/shell/About';
import { CUSTOM_WALLPAPER_KEY } from '@/desktop/Wallpaper';
import { Button } from '@/ui/Button';
import { Kbd, Notice } from '@/ui/Feedback';
import { Segmented, Switch, TextInput } from '@/ui/Form';
import { LoginForm } from '@/ui/LoginForm';

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

function Group({ title, children, description }: { title?: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      {title ? <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-fg-subtle">{title}</h3> : null}
      {description ? <p className="mb-2 text-sm text-fg-subtle">{description}</p> : null}
      <div className="divide-y divide-line-faint overflow-hidden rounded-lg border border-line-soft bg-surface-2/50">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-6 px-4 py-2.5">
      <div className="min-w-0">
        <div className="text-base text-fg">{label}</div>
        {hint ? <div className="mt-0.5 text-sm text-fg-subtle">{hint}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row label={label} hint={hint}>
      <Switch checked={checked} onChange={onChange} label={label} />
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Erscheinungsbild
// ---------------------------------------------------------------------------

export function AppearanceSection() {
  const s = useSettings();
  return (
    <>
      <Group title="Akzentfarbe" description="Wird sparsam für Auswahl, Fokus und aktive Elemente verwendet.">
        <div className="flex flex-wrap gap-3 p-4">
          {(Object.keys(ACCENTS) as AccentId[]).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={s.accent === id}
              onClick={() => s.set('accent', id)}
              className={cn('flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3 text-sm', s.accent === id ? 'border-fg/60 bg-surface-3' : 'border-line-soft hover:bg-surface-3/60')}
            >
              <span className="h-5 w-5 rounded-full" style={{ background: ACCENTS[id].value }} />
              {ACCENTS[id].label}
            </button>
          ))}
        </div>
      </Group>
      <Group title="Bewegung & Effekte">
        <Row label="Animationen" hint="„System“ folgt der iPadOS-Einstellung „Bewegung reduzieren“.">
          <Segmented
            label="Animationen"
            size="sm"
            value={s.motion}
            onChange={(v) => s.set('motion', v)}
            options={[
              { value: 'system', label: 'System' },
              { value: 'reduced', label: 'Reduziert' },
              { value: 'full', label: 'Voll' },
            ]}
          />
        </Row>
        <ToggleRow label="Transparenzeffekte" hint="Leichte Unschärfe hinter Dock, Menüs und Panels." checked={s.transparency} onChange={(v) => s.set('transparency', v)} />
        <Row label="Textgröße" hint="Skaliert die gesamte Oberfläche.">
          <Segmented
            label="Textgröße"
            size="sm"
            value={s.uiScale}
            onChange={(v) => s.set('uiScale', v)}
            options={[
              { value: 1, label: 'Standard' },
              { value: 1.08, label: 'Größer' },
              { value: 1.16, label: 'Groß' },
            ]}
          />
        </Row>
      </Group>
      <Group title="Uhr">
        <ToggleRow label="24-Stunden-Format" checked={s.clock24h} onChange={(v) => s.set('clock24h', v)} />
        <ToggleRow label="Sekunden anzeigen" checked={s.clockSeconds} onChange={(v) => s.set('clockSeconds', v)} />
        <ToggleRow label="Datum anzeigen" checked={s.clockShowDate} onChange={(v) => s.set('clockShowDate', v)} />
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Desktop
// ---------------------------------------------------------------------------

export function DesktopSection() {
  const s = useSettings();
  const chooseCustom = async () => {
    const [file] = await pickFiles({ accept: 'image/png,image/jpeg,image/webp' });
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 25 * 1024 * 1024) {
      notify({ kind: 'error', title: 'Bitte ein PNG-, JPEG- oder WebP-Bild bis 25 MB wählen.' });
      return;
    }
    await kvSet(CUSTOM_WALLPAPER_KEY, file);
    s.set('wallpaper', 'custom');
    window.dispatchEvent(new Event('renos:wallpaper-changed'));
  };
  const options: Array<{ id: WallpaperId; label: string; thumb: string | null }> = [
    ...(Object.keys(WALLPAPERS) as Array<keyof typeof WALLPAPERS>).map((id) => ({ id, label: WALLPAPERS[id].label, thumb: WALLPAPERS[id].thumb })),
    { id: 'solid', label: 'Schlicht', thumb: null },
  ];
  return (
    <>
      <Group title="Hintergrundbild">
        <div className="grid grid-cols-3 gap-3 p-4">
          {options.map((o) => (
            <button key={o.id} type="button" aria-pressed={s.wallpaper === o.id} onClick={() => s.set('wallpaper', o.id)} className="text-left">
              <div className={cn('aspect-[4/3] overflow-hidden rounded-md border-2', s.wallpaper === o.id ? 'border-accent' : 'border-transparent')}>
                {o.thumb ? (
                  <img src={o.thumb} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="h-full w-full" style={{ background: 'radial-gradient(120% 90% at 70% 20%, #1d2533 0%, #141922 55%, #10141b 100%)' }} />
                )}
              </div>
              <div className="mt-1.5 text-sm text-fg-muted">{o.label}</div>
            </button>
          ))}
          <button type="button" aria-pressed={s.wallpaper === 'custom'} onClick={() => void chooseCustom()} className="text-left">
            <div className={cn('flex aspect-[4/3] items-center justify-center rounded-md border-2 border-dashed text-fg-subtle', s.wallpaper === 'custom' ? 'border-accent' : 'border-line')}>
              <ImagePlus size={22} />
            </div>
            <div className="mt-1.5 text-sm text-fg-muted">Eigenes Bild …</div>
          </button>
        </div>
      </Group>
      <Group>
        <Row label="Hintergrund abdunkeln" hint={`${Math.round(s.wallpaperDim * 100)} %`}>
          <input
            type="range"
            min={0}
            max={0.6}
            step={0.05}
            value={s.wallpaperDim}
            onChange={(e) => s.set('wallpaperDim', Number(e.target.value))}
            aria-label="Hintergrund abdunkeln"
            className="w-40 accent-[var(--accent)]"
          />
        </Row>
        <ToggleRow label="Tippen startet Suche" hint="Tippen auf dem leeren Schreibtisch öffnet die Anwendungssuche." checked={s.typeToSearch} onChange={(v) => s.set('typeToSearch', v)} />
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Dock
// ---------------------------------------------------------------------------

export function DockSection() {
  const s = useSettings();
  const toggle = (id: AppId, on: boolean) => s.set('pinnedApps', on ? APP_IDS.filter((a) => a === id || s.pinnedApps.includes(a)) : s.pinnedApps.filter((a) => a !== id));
  return (
    <>
      <Group title="Verhalten">
        <Row label="Größe">
          <Segmented
            label="Dockgröße"
            size="sm"
            value={s.dockSize}
            onChange={(v) => s.set('dockSize', v)}
            options={[
              { value: 'small', label: 'Klein' },
              { value: 'medium', label: 'Mittel' },
              { value: 'large', label: 'Groß' },
            ]}
          />
        </Row>
        <ToggleRow label="Automatisch ausblenden" hint="Erscheint, wenn der Zeiger den unteren Rand erreicht oder dort getippt wird. Fenster erhalten mehr Platz." checked={s.dockAutohide} onChange={(v) => s.set('dockAutohide', v)} />
        <ToggleRow label="Laufende Apps anzeigen" hint="Nicht angeheftete, geöffnete Apps erscheinen rechts im Dock." checked={s.dockShowRunning} onChange={(v) => s.set('dockShowRunning', v)} />
      </Group>
      <Group title="Angeheftete Apps">
        {APP_IDS.filter((id) => APP_META[id].showInLauncher).map((id) => (
          <Row key={id} label={APP_META[id].name} hint={APP_META[id].description}>
            <Switch checked={s.pinnedApps.includes(id)} onChange={(v) => toggle(id, v)} label={`${APP_META[id].name} im Dock`} />
          </Row>
        ))}
      </Group>
      <Button variant="ghost" icon={RotateCcw} onClick={() => s.patch({ pinnedApps: DEFAULT_SETTINGS.pinnedApps, dockSize: DEFAULT_SETTINGS.dockSize, dockAutohide: false, dockShowRunning: true })}>
        Dock zurücksetzen
      </Button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Fenster
// ---------------------------------------------------------------------------

export function WindowsSection() {
  const s = useSettings();
  return (
    <>
      <Group>
        <ToggleRow label="An Bildschirmrändern einrasten" hint="Fenster an den linken/rechten Rand ziehen für eine Hälfte, an den oberen Rand zum Maximieren." checked={s.windowSnapping} onChange={(v) => s.set('windowSnapping', v)} />
        <ToggleRow label="Fenster beim Start wiederherstellen" hint="Öffnet beim nächsten Start dieselben Fenster an denselben Positionen (Spiele werden nie automatisch gestartet)." checked={s.restoreSession} onChange={(v) => s.set('restoreSession', v)} />
        <Row label="Doppelklick auf Titelleiste">
          <Segmented
            label="Doppelklick auf Titelleiste"
            size="sm"
            value={s.titlebarDoubleClick}
            onChange={(v) => s.set('titlebarDoubleClick', v)}
            options={[
              { value: 'maximize', label: 'Maximieren' },
              { value: 'minimize', label: 'Minimieren' },
              { value: 'none', label: 'Nichts' },
            ]}
          />
        </Row>
      </Group>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => useWindows.getState().arrange()}>{t.desktop.arrange}</Button>
        <Button
          variant="ghost"
          icon={RotateCcw}
          onClick={() => {
            useWindows.getState().resetGeometry();
            notify({ kind: 'success', title: 'Fensterpositionen zurückgesetzt.', transient: true });
          }}
        >
          Fensterpositionen zurücksetzen
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tastatur
// ---------------------------------------------------------------------------

const APP_KEYS: Array<{ group: string; keys: string; description: string }> = [
  { group: 'Files', keys: '↩', description: 'Öffnen' },
  { group: 'Files', keys: '⌘ ⌫ / Entf', description: 'In den Papierkorb' },
  { group: 'Files', keys: '⌥R / F2', description: 'Umbenennen' },
  { group: 'Files', keys: '⌘⇧N', description: 'Neuer Ordner' },
  { group: 'Files', keys: '⌘C · ⌘X · ⌘V', description: 'Kopieren · Ausschneiden · Einfügen' },
  { group: 'Files', keys: '⌘[ · ⌘] · ⌘↑', description: 'Zurück · Vorwärts · Übergeordneter Ordner' },
  { group: 'Library', keys: '← → ↑ ↓ · ↩', description: 'Spiel wählen · Spielen' },
  { group: 'Terminal', keys: '↑ ↓ · ⇥', description: 'Verlauf · Vervollständigen' },
  { group: 'Terminal', keys: '⌃L · ⌃C', description: 'Leeren · Abbrechen' },
  { group: 'Spiel', keys: '⌥⇧Esc', description: 'Immersiven Spielmodus verlassen' },
];

export function KeyboardSection() {
  const s = useSettings();
  const shortcuts = useSyncExternalStore(subscribeShortcuts, listShortcuts, listShortcuts);
  const groups = new Map<string, typeof shortcuts>();
  for (const sc of shortcuts) {
    if (sc.scope !== 'global') continue;
    groups.set(sc.group, [...(groups.get(sc.group) ?? []), sc]);
  }
  return (
    <>
      <Group>
        <ToggleRow label="System-Tastenkürzel" hint="Kürzel für Suche, Fenster und Einstellungen. App-eigene Kürzel bleiben aktiv." checked={s.shortcutsEnabled} onChange={(v) => s.set('shortcutsEnabled', v)} />
      </Group>
      <Notice className="mb-6 text-sm">
        iPadOS und Safari können einzelne Tastenkombinationen (vor allem mit ⌘) für sich reservieren – diese erreichen RenOS dann nicht. RenOS nutzt deshalb
        überwiegend die Wahltaste ⌥. Während ein Spiel den Fokus hat, gehen alle Tasten an das Spiel.
      </Notice>
      {[...groups.entries()].map(([group, list]) => (
        <Group key={group} title={group}>
          {list.map((sc) => (
            <Row key={sc.id} label={sc.description}>
              <span className="flex flex-wrap justify-end gap-1">
                {(Array.isArray(sc.keys) ? sc.keys : [sc.keys]).slice(0, 2).map((k) => (
                  <Kbd key={k}>{formatCombo(k)}</Kbd>
                ))}
              </span>
            </Row>
          ))}
        </Group>
      ))}
      <Group title="In Anwendungen">
        {APP_KEYS.map((k) => (
          <Row key={`${k.group}-${k.description}`} label={`${k.group}: ${k.description}`}>
            <Kbd>{k.keys}</Kbd>
          </Row>
        ))}
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Speicher
// ---------------------------------------------------------------------------

export function StorageSection() {
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [stats, setStats] = useState<{ files: number; folders: number; bytes: number; notes: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const e = await navigator.storage?.estimate?.();
      setEstimate(e?.quota ? { usage: e.usage ?? 0, quota: e.quota } : null);
      setPersisted((await navigator.storage?.persisted?.()) ?? null);
    } catch {
      setEstimate(null);
    }
    const u = await usage();
    setStats({ ...u, notes: await db.notes.count() });
  };
  useEffect(() => {
    void refresh();
  }, []);

  const exportBackup = async () => {
    setBusy('export');
    try {
      downloadBlob(await createBackup(), `RenOS-Sicherung-${new Date().toISOString().slice(0, 10)}.zip`);
    } finally {
      setBusy(null);
    }
  };

  const importBackup = async () => {
    const [file] = await pickFiles({ accept: '.zip,application/zip' });
    if (!file) return;
    setBusy('import');
    try {
      const result = await restoreBackup(file);
      notify({
        kind: 'success',
        title: 'Sicherung wiederhergestellt',
        message: `${result.notes} Notizen, ${result.files} Dateien${result.folderName ? ` (in „${result.folderName}“)` : ''}.`,
      });
      void refresh();
    } catch (error) {
      notify({ kind: 'error', title: 'Wiederherstellung fehlgeschlagen', message: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const clearNotes = async () => {
    if (!(await confirmDialog({ title: 'Alle Notizen löschen?', message: 'Alle Notizen werden endgültig gelöscht.', confirmLabel: t.system.delete, destructive: true }))) return;
    await db.notes.clear();
    notify({ kind: 'success', title: 'Notizen gelöscht.', transient: true });
    void refresh();
  };

  const clearFiles = async () => {
    if (!(await confirmDialog({ title: 'Alle Dateien löschen?', message: 'Alle Dateien und Ordner (inklusive Papierkorb) werden endgültig gelöscht. Die Standardordner bleiben erhalten.', confirmLabel: t.system.delete, destructive: true })))
      return;
    const ids: string[] = [];
    for (const folder of [HOME_ID, ...SPECIAL_FOLDERS.map((f) => f.id)]) for (const child of await listChildren(folder)) if (!SPECIAL_FOLDERS.some((f) => f.id === child.id)) ids.push(child.id);
    ids.push(...(await db.nodes.where('trashed').equals(1).primaryKeys()));
    await deleteNodes(ids);
    notify({ kind: 'success', title: 'Dateien gelöscht.', transient: true });
    void refresh();
  };

  const resetAll = async () => {
    if (!(await confirmDialog({ title: 'RenOS vollständig zurücksetzen?', message: 'Alle lokalen Daten – Notizen, Dateien, Einstellungen und Fenster – werden gelöscht. Spiele auf dem Server bleiben erhalten.', confirmLabel: 'Alles löschen', destructive: true })))
      return;
    await wipeLocalData();
    window.location.reload();
  };

  return (
    <>
      <Group title="Lokaler Speicher" description="Notizen, Dateien und Einstellungen liegen in diesem Browser bzw. dieser Web-App (IndexedDB).">
        <div className="p-4">
          <div className="h-2 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-accent" style={{ width: estimate ? `${Math.min(100, (estimate.usage / estimate.quota) * 100)}%` : '0%' }} />
          </div>
          <p className="mt-2 text-sm text-fg-muted">
            {estimate ? `${formatBytes(estimate.usage)} von ${formatBytes(estimate.quota)} belegt (Schätzung des Browsers)` : 'Der Browser stellt keine Speicherangaben bereit.'}
          </p>
          {stats ? (
            <p className="mt-1 text-sm text-fg-subtle">
              {stats.files} Dateien ({formatBytes(stats.bytes)}) · {stats.folders} Ordner · {stats.notes} Notizen
            </p>
          ) : null}
        </div>
        <Row
          label="Dauerhafter Speicher"
          hint={
            persisted === true
              ? 'Gewährt: iPadOS entfernt die Daten nicht automatisch bei Speicherknappheit.'
              : 'Nicht gewährt: iPadOS kann Websitedaten bei Speicherknappheit oder längerer Nichtnutzung entfernen. Regelmäßige Sicherungen werden empfohlen.'
          }
        >
          {persisted === true ? (
            <span className="text-sm text-success">Aktiv</span>
          ) : (
            <Button size="sm" onClick={() => void requestPersistentStorage().then((v) => setPersisted(v))}>
              Anfordern
            </Button>
          )}
        </Row>
      </Group>
      <Group title="Datensicherung" description="Sichert Notizen, Dateien und Einstellungen in einer ZIP-Datei. Spiele und Spielstände sind nicht enthalten.">
        <Row label="Sicherung exportieren" hint="Speichert eine ZIP-Datei (auf dem iPad z. B. in iCloud Drive).">
          <Button size="sm" icon={Download} loading={busy === 'export'} onClick={() => void exportBackup()}>
            Exportieren
          </Button>
        </Row>
        <Row label="Sicherung importieren" hint="Ergänzt vorhandene Daten; Dateien landen in einem neuen Ordner.">
          <Button size="sm" icon={Upload} loading={busy === 'import'} onClick={() => void importBackup()}>
            Importieren …
          </Button>
        </Row>
      </Group>
      <Group title="Lokale Daten löschen">
        <Row label="Alle Notizen löschen">
          <Button size="sm" variant="danger" icon={Trash2} onClick={() => void clearNotes()}>
            Löschen …
          </Button>
        </Row>
        <Row label="Alle Dateien löschen">
          <Button size="sm" variant="danger" icon={Trash2} onClick={() => void clearFiles()}>
            Löschen …
          </Button>
        </Row>
        <Row label="Einstellungen zurücksetzen">
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => useSettings.getState().reset()}>
            Zurücksetzen
          </Button>
        </Row>
        <Row label="RenOS vollständig zurücksetzen" hint="Löscht alle lokalen Daten und startet neu.">
          <Button size="sm" variant="danger" onClick={() => void resetAll()}>
            Alles löschen …
          </Button>
        </Row>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Spiele & Server
// ---------------------------------------------------------------------------

export function GamesSection() {
  const s = useSettings();
  const server = useServer(useShallow((st) => ({ status: st.status, health: st.health, session: st.session, logout: st.logout, refreshHealth: st.refreshHealth, refreshSession: st.refreshSession })));
  return (
    <>
      <Group title="RenOS-Server">
        <Row label="Status" hint={server.health ? `Version ${server.health.version}` : undefined}>
          <span className={cn('text-sm', server.status === 'online' ? 'text-success' : server.status === 'offline' ? 'text-warning' : 'text-fg-subtle')}>
            {server.status === 'online' ? 'Erreichbar' : server.status === 'offline' ? 'Nicht erreichbar' : 'Wird geprüft …'}
          </span>
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void server.refreshHealth().then(() => server.refreshSession())}>
            Prüfen
          </Button>
        </Row>
        {server.health ? (
          <>
            <Row label="Spiele-Origin" hint="Spiele laufen isoliert auf diesem separaten Origin.">
              <code className="selectable font-mono text-sm text-fg-muted">{server.health.gameOrigin}</code>
            </Row>
            <Row label="Upload-Limit">
              <span className="text-sm text-fg-muted">{formatBytes(server.health.limits.maxUploadBytes)}</span>
            </Row>
          </>
        ) : null}
        <Row label="Anmeldung" hint={server.session?.authenticated && server.session.expiresAt ? `Gültig bis ${new Date(server.session.expiresAt).toLocaleDateString('de-DE')}` : t.auth.description}>
          {server.session?.authenticated ? (
            <Button size="sm" icon={LogOut} onClick={() => void server.logout().then(() => notify({ kind: 'info', title: t.auth.loggedOutToast, transient: true }))}>
              {t.auth.logout}
            </Button>
          ) : (
            <span className="text-sm text-fg-subtle">{t.auth.loggedOut}</span>
          )}
        </Row>
      </Group>
      {server.status === 'online' && !server.session?.authenticated ? (
        <div className="mb-6 rounded-lg border border-line-soft bg-surface-2/50 p-4">
          <LoginForm compact />
        </div>
      ) : null}
      <Group title="Player">
        <ToggleRow label="Spiele im immersiven Modus starten" hint="Das Spiel füllt den ganzen Bildschirm; Systemleiste und Dock werden ausgeblendet." checked={s.playerImmersive} onChange={(v) => s.set('playerImmersive', v)} />
        <ToggleRow label="Spielsteuerung automatisch ausblenden" hint="Die Leiste erscheint, wenn der Zeiger den oberen Rand erreicht oder der Griff angetippt wird." checked={s.playerAutohideControls} onChange={(v) => s.set('playerAutohideControls', v)} />
      </Group>
      <Notice className="text-sm">
        <strong className="text-fg">{t.library.savesTitle}:</strong> {t.library.savesText} Spielstände liegen im Speicher des Spiele-Origins und werden von
        der RenOS-Sicherung nicht erfasst.
      </Notice>
    </>
  );
}

// ---------------------------------------------------------------------------
// Systeminformationen
// ---------------------------------------------------------------------------

function showInstallHelp() {
  void openDialog({
    title: 'RenOS installieren',
    width: 480,
    render: (close) => (
      <div>
        <h2 className="text-lg font-semibold">RenOS auf dem iPad installieren</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-base text-fg-muted">
          <li>RenOS in Safari öffnen (über HTTPS).</li>
          <li>„Teilen“ antippen (Adressleiste oder Menü „…“).</li>
          <li>„Zum Home-Bildschirm“ wählen, „Als Web-App öffnen“ eingeschaltet lassen, „Hinzufügen“.</li>
          <li>RenOS über das neue Symbol starten.</li>
        </ol>
        <p className="mt-3 text-sm text-fg-subtle">Installierte Web-Apps haben unter iPadOS einen eigenen Speicher, getrennt von Safari.</p>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={close}>
            {t.system.close}
          </Button>
        </div>
      </div>
    ),
  });
}

export function AboutSection() {
  const s = useSettings();
  const [name, setName] = useState(s.userName);
  const nameValid = /^[a-z][a-z0-9_-]{0,31}$/.test(name);
  const [, setTick] = useState(0);
  useEffect(() => {
    const onResize = () => setTick((x) => x + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const sw = serviceWorkerState();
  const info: Array<[string, string]> = [
    ['Version', `RenOS ${RENOS_VERSION}`],
    ['Darstellung', displayModeLabel()],
    ['Browser-Engine', browserName()],
    ['Bildschirm', `${window.screen.width} × ${window.screen.height} pt · Skalierung ${window.devicePixelRatio}x`],
    ['Fenster', `${window.innerWidth} × ${window.innerHeight} pt`],
    ['Eingabe', `${hasFinePointer() ? 'Präziser Zeiger verfügbar' : 'Nur Touch'} · ${hasHover() ? 'Hover verfügbar' : 'kein Hover'}`],
    ['Netzwerk', navigator.onLine ? 'Online' : 'Offline'],
    ['Offline-Start', sw === 'active' ? 'Service Worker aktiv' : sw === 'dev' ? 'Im Entwicklungsmodus deaktiviert' : sw === 'unsupported' ? 'Nicht unterstützt' : sw === 'failed' ? 'Registrierung fehlgeschlagen' : 'Wird eingerichtet'],
  ];
  return (
    <>
      <div className="mb-6 flex items-center gap-4">
        <img src="/icons/icon-192.png" alt="" className="h-16 w-16" />
        <div>
          <div className="text-lg font-semibold">RenOS</div>
          <div className="text-sm text-fg-muted">Version {RENOS_VERSION} · {isStandalone() ? 'installiert' : 'im Browser'}</div>
        </div>
      </div>
      <Group title="System">
        {info.map(([k, v]) => (
          <Row key={k} label={k}>
            <span className="selectable text-right text-sm text-fg-muted">{v}</span>
          </Row>
        ))}
        <div className="px-4 py-3">
          <div className="text-sm text-fg-subtle">User-Agent</div>
          <code className="selectable mt-1 block break-all font-mono text-xs text-fg-muted">{navigator.userAgent}</code>
        </div>
      </Group>
      <Group title="Benutzer">
        <Row label="Benutzername" hint={nameValid ? 'Wird im Terminal angezeigt.' : 'Kleinbuchstaben, Ziffern, - und _; beginnt mit einem Buchstaben.'}>
          <TextInput value={name} onChange={(e) => setName(e.target.value.toLowerCase())} invalid={!nameValid} className="w-40" aria-label="Benutzername" />
          <Button size="sm" disabled={!nameValid || name === s.userName} onClick={() => s.set('userName', name)}>
            {t.system.save}
          </Button>
        </Row>
      </Group>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => window.dispatchEvent(new Event('renos:onboarding'))}>Einführung erneut anzeigen</Button>
        <Button variant="ghost" onClick={showInstallHelp}>
          Installationshinweise
        </Button>
        <Button variant="ghost" onClick={showAbout}>
          {t.desktop.about}
        </Button>
      </div>
    </>
  );
}
