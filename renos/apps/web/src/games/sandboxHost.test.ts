import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_CSP, BUILTIN_SANDBOX, SANDBOX_BASE, attachSandboxSession, buildSandboxDocument } from './sandboxHost';

describe('eingebauter Spiele-Host', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('gibt dem Spiel nie den Origin von RenOS', () => {
    const flags = BUILTIN_SANDBOX.split(' ');
    expect(flags).toContain('allow-scripts');
    expect(flags).not.toContain('allow-same-origin');
    expect(flags).not.toContain('allow-top-navigation');
    expect(flags).not.toContain('allow-popups');
  });

  it('baut ein Dokument mit strenger CSP, virtueller Basisadresse und eingesetzter Konfiguration', () => {
    const html = buildSandboxDocument('https://example.github.io');
    expect(html).toContain(`<base href="${SANDBOX_BASE}">`);
    expect(html).toContain("default-src 'none'");
    expect(BUILTIN_CSP).toContain("connect-src blob: data:");
    expect(BUILTIN_CSP).not.toMatch(/connect-src[^;]*https?:/);
    expect(html).not.toContain('})(__RENOS_CONFIG__);');
    expect(html).toContain(`})({"base":"${SANDBOX_BASE}","parentOrigin":"https://example.github.io"});`);
    // Genau ein schließendes Skript-Tag: die Laufzeit kann das Dokument nicht vorzeitig beenden.
    expect(html.match(/<\/script/gi)?.length).toBe(1);
  });

  it('maskiert die Konfiguration gegen HTML-Einschleusung', () => {
    const html = buildSandboxDocument('https://x.example</script><script>alert(1)</script>');
    expect(html.match(/<\/script/gi)?.length).toBe(1);
  });

  it('bricht ab, wenn RenOS das Spieldokument lesen kann (Trennung aufgehoben)', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const onUnsafe = vi.fn();
    const onBridgeMessage = vi.fn();
    const detach = attachSandboxSession(iframe, 'aaaaaaaaaaaaaaaaaaaaaaaa', { onBridgeMessage, onUnsafe });
    const ready = { source: 'renos-sandbox', v: 1, type: 'ready' };

    // Fremde Absender und falsche Origins werden ignoriert.
    window.dispatchEvent(new MessageEvent('message', { data: ready, origin: 'null', source: window }));
    window.dispatchEvent(new MessageEvent('message', { data: ready, origin: window.location.origin, source: iframe.contentWindow }));
    expect(onUnsafe).not.toHaveBeenCalled();

    // jsdom-iframes sind gleichen Ursprungs – genau der Fall, den RenOS ablehnen muss.
    window.dispatchEvent(new MessageEvent('message', { data: ready, origin: 'null', source: iframe.contentWindow }));
    expect(onUnsafe).toHaveBeenCalledTimes(1);
    detach();
  });
});
