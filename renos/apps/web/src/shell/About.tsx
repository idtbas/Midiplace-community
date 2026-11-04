import { RENOS_VERSION } from '@renos/shared';
import { t } from '@/i18n';
import { openDialog } from '@/system/dialogs';
import { Button } from '@/ui/Button';
import { asset } from '@/config';

export function showAbout(): void {
  void openDialog({
    title: t.desktop.about,
    width: 440,
    render: (close) => (
      <div className="flex flex-col items-center text-center">
        <img src={asset('icons/icon-192.png')} alt="" className="h-20 w-20" />
        <h2 className="mt-3 text-xl font-semibold">RenOS</h2>
        <p className="text-sm text-fg-muted">Version {RENOS_VERSION}</p>
        <p className="mt-4 text-base text-fg-muted">
          Eine Desktop-Umgebung als Web-App für das iPad mit Magic Keyboard. RenOS verwaltet und startet Ren’Py-Web-Builds in einer
          isolierten Umgebung.
        </p>
        <p className="mt-3 text-sm text-fg-subtle">
          RenOS ist kein eigenes Betriebssystem und ersetzt iPadOS nicht – es läuft als installierte Web-App innerhalb von Safari/WebKit.
        </p>
        <p className="mt-3 text-sm text-fg-subtle">Ren’Py ist ein Projekt von Tom Rothamel und Mitwirkenden (renpy.org) und nicht Teil von RenOS.</p>
        <Button variant="primary" className="mt-5" onClick={close}>
          {t.system.close}
        </Button>
      </div>
    ),
  });
}
