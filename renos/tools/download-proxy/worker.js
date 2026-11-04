/**
 * RenOS – eigener Weiterleitungsdienst für Downloads (Cloudflare Worker, kostenlos).
 *
 * Manche Datei-Hoster erlauben Web-Apps keine Downloads (kein CORS). Dieser kleine Dienst holt die Datei
 * und reicht sie an RenOS weiter – nur für die eingetragene RenOS-Adresse, nur lesend (GET), nur
 * öffentliche Adressen. Er speichert nichts.
 *
 * Einrichtung (README → „Downloads von allen Seiten“):
 *   1. dash.cloudflare.com → Workers & Pages → Create → Worker → Deploy → Edit code
 *   2. Diesen Text einfügen → Deploy
 *   3. Settings → Variables and Secrets → ALLOWED_ORIGINS = https://<name>.github.io
 *   4. Die Adresse des Workers (https://….workers.dev) in RenOS eintragen:
 *      Settings → Browser & Downloads → Eigener Weiterleitungsdienst → Prüfen & speichern
 */

const EXPOSE = 'Content-Disposition, Content-Length, Content-Type, X-Final-Url';

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Expose-Headers': EXPOSE,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Keine internen oder lokalen Ziele (Schutz vor Missbrauch als Brücke ins eigene Netz). */
function publicTarget(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(127|10|0)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.includes(':')
  ) {
    return null;
  }
  return url;
}

export default {
  async fetch(request, env) {
    const allowed = String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    if (!allowed.includes(origin)) return new Response('Nicht erlaubt.', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'GET') return new Response('Nur GET.', { status: 405, headers: cors(origin) });

    const target = publicTarget(new URL(request.url).searchParams.get('url') || '');
    if (!target) return new Response('Ungültige Adresse.', { status: 400, headers: cors(origin) });

    const upstream = await fetch(target.href, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RenOS-Download)', Accept: '*/*' },
    });
    const headers = new Headers(cors(origin));
    for (const name of ['Content-Type', 'Content-Length', 'Content-Disposition', 'Last-Modified']) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set('X-Final-Url', upstream.url || target.href);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
