import { useEffect, useRef, useState } from 'react';
import { AlarmClock, type Clock3, Flag, Globe2, Hourglass, Pause, Play, Plus, RotateCcw, Timer, Trash2, X } from 'lucide-react';
import { locale } from '@/i18n';
import { cn } from '@/lib/cn';
import { useAlarms } from '@/system/alarms';
import type { AppProps } from '@/system/apps';
import { useSettings } from '@/system/settings';
import { Button, IconButton } from '@/ui/Button';
import { Switch, TextInput } from '@/ui/Form';

type Tab = 'world' | 'alarm' | 'timer' | 'stopwatch';

const ZONES: Array<{ id: string; city: string }> = [
  { id: 'Europe/Berlin', city: 'Berlin' },
  { id: 'Europe/London', city: 'London' },
  { id: 'America/New_York', city: 'New York' },
  { id: 'America/Los_Angeles', city: 'Los Angeles' },
  { id: 'Asia/Tokyo', city: 'Tokio' },
  { id: 'Asia/Shanghai', city: 'Shanghai' },
  { id: 'Asia/Kolkata', city: 'Neu-Delhi' },
  { id: 'Australia/Sydney', city: 'Sydney' },
  { id: 'America/Sao_Paulo', city: 'São Paulo' },
  { id: 'Africa/Cairo', city: 'Kairo' },
  { id: 'Europe/Moscow', city: 'Moskau' },
  { id: 'Pacific/Auckland', city: 'Auckland' },
];
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WORLD_KEY = 'renos.clock.zones';

function useNow(interval = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(id);
  }, [interval]);
  return now;
}

export function formatDuration(ms: number, withCentis = false): string {
  const total = Math.max(0, ms);
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  const base = `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
  return withCentis ? `${base},${String(cs).padStart(2, '0')}` : base;
}

function WorldClock() {
  const now = useNow();
  const clock24h = useSettings((s) => s.clock24h);
  const [zones, setZones] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(WORLD_KEY) ?? 'null') as unknown;
      return Array.isArray(stored) ? stored.filter((z): z is string => typeof z === 'string') : ['America/New_York', 'Asia/Tokyo'];
    } catch {
      return ['America/New_York', 'Asia/Tokyo'];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(WORLD_KEY, JSON.stringify(zones));
    } catch {
      /* ignorieren */
    }
  }, [zones]);
  const fmt = (zone?: string, seconds = false) =>
    new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: !clock24h, timeZone: zone }).format(now);
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = (zone: string) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(now);
    return parts.find((p) => p.type === 'timeZoneName')?.value.replace('GMT', 'UTC') ?? '';
  };
  const available = ZONES.filter((z) => !zones.includes(z.id));
  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="text-center">
        <div className="tabular text-6xl font-light" data-testid="clock-local">
          {fmt(undefined, true)}
        </div>
        <div className="mt-1 text-sm text-fg-muted">
          {new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now)} · {local}
        </div>
      </div>
      <div className="flex flex-col divide-y divide-line-soft rounded-lg border border-line-soft">
        {zones.map((zone) => (
          <div key={zone} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-base font-medium">{ZONES.find((z) => z.id === zone)?.city ?? zone}</div>
              <div className="text-xs text-fg-subtle">{offset(zone)}</div>
            </div>
            <div className="tabular text-xl">{fmt(zone)}</div>
            <IconButton icon={X} label="Entfernen" size="sm" onClick={() => setZones((z) => z.filter((x) => x !== zone))} />
          </div>
        ))}
      </div>
      {available.length ? (
        <select
          className="h-9 rounded-md border border-line bg-surface-2 px-2 text-sm"
          value=""
          onChange={(e) => e.target.value && setZones((z) => [...z, e.target.value])}
          aria-label="Stadt hinzufügen"
        >
          <option value="">Stadt hinzufügen …</option>
          {available.map((z) => (
            <option key={z.id} value={z.id}>
              {z.city}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function Alarms() {
  const { alarms, addAlarm, updateAlarm, removeAlarm } = useAlarms();
  const [time, setTime] = useState('07:00');
  const [label, setLabel] = useState('');
  const [days, setDays] = useState<number[]>([]);
  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-2 rounded-lg border border-line-soft p-3">
        <div className="flex gap-2">
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="tabular h-9 rounded-md border border-line bg-surface-2 px-2 text-base" aria-label="Uhrzeit" data-testid="alarm-time" />
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Bezeichnung (optional)" aria-label="Bezeichnung" maxLength={60} />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays((v) => (v.includes(d) ? v.filter((x) => x !== d) : [...v, d]))}
              className={cn('h-8 w-9 rounded-md text-sm', days.includes(d) ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-fg-muted hover:bg-surface-3')}
            >
              {WEEKDAYS[d]}
            </button>
          ))}
          <span className="ml-2 text-xs text-fg-subtle">{days.length ? 'wiederholt' : 'einmalig'}</span>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="primary"
            icon={Plus}
            onClick={() => {
              if (!/^\d{2}:\d{2}$/.test(time)) return;
              addAlarm({ time, label: label.trim(), days: [...days].sort() });
              setLabel('');
            }}
            data-testid="alarm-add"
          >
            Wecker hinzufügen
          </Button>
        </div>
      </div>
      <div className="flex flex-col divide-y divide-line-soft">
        {alarms.length === 0 ? <p className="py-4 text-center text-sm text-fg-subtle">Keine Wecker gestellt.</p> : null}
        {alarms.map((a) => (
          <div key={a.id} className="flex items-center gap-3 py-2" data-testid="alarm-item">
            <div className={cn('tabular text-3xl font-light', !a.enabled && 'text-fg-faint')}>{a.time}</div>
            <div className="min-w-0 flex-1 text-sm">
              <div className="truncate text-fg">{a.label || 'Wecker'}</div>
              <div className="text-xs text-fg-subtle">{a.days.length ? a.days.map((d) => WEEKDAYS[d]).join(', ') : 'Einmalig'}</div>
            </div>
            <Switch checked={a.enabled} onChange={(v) => updateAlarm(a.id, { enabled: v, lastFired: null })} label={`Wecker ${a.time}`} />
            <IconButton icon={Trash2} label="Löschen" size="sm" onClick={() => removeAlarm(a.id)} />
          </div>
        ))}
      </div>
      <p className="text-xs text-fg-subtle">Wecker und Timer klingeln, solange RenOS geöffnet ist – auch wenn die Uhr-App geschlossen ist. Ist RenOS ganz geschlossen, kann iPadOS es nicht wecken.</p>
    </div>
  );
}

function TimerTab() {
  const { timer, startTimer, cancelTimer } = useAlarms();
  const now = useNow(250);
  const [minutes, setMinutes] = useState(5);
  const [seconds, setSeconds] = useState(0);
  const remaining = timer ? timer.endsAt - now : 0;
  const ratio = timer ? Math.min(1, Math.max(0, remaining / timer.durationMs)) : 0;
  return (
    <div className="flex flex-col items-center gap-5 p-5">
      <div className="relative flex h-52 w-52 items-center justify-center">
        <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90">
          <circle cx="50" cy="50" r="45" fill="none" stroke="var(--surface-3, #2a2f38)" strokeWidth="5" />
          {timer ? <circle cx="50" cy="50" r="45" fill="none" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" strokeDasharray={`${ratio * 283} 283`} /> : null}
        </svg>
        <div className="tabular text-4xl font-light" data-testid="timer-remaining">
          {timer ? formatDuration(remaining) : formatDuration((minutes * 60 + seconds) * 1000)}
        </div>
      </div>
      {timer ? (
        <Button icon={X} onClick={cancelTimer} data-testid="timer-cancel">
          Abbrechen
        </Button>
      ) : (
        <>
          <div className="flex flex-wrap justify-center gap-2">
            {[1, 3, 5, 10, 15, 30, 60].map((m) => (
              <button key={m} type="button" onClick={() => (setMinutes(m), setSeconds(0))} className={cn('rounded-full px-3 py-1 text-sm', minutes === m && seconds === 0 ? 'bg-accent text-accent-fg' : 'bg-surface-2 hover:bg-surface-3')}>
                {m} min
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <input type="number" min={0} max={999} value={minutes} onChange={(e) => setMinutes(Math.max(0, Math.min(999, Number(e.target.value) || 0)))} className="tabular h-9 w-20 rounded-md border border-line bg-surface-2 px-2" aria-label="Minuten" data-testid="timer-minutes" />
            min
            <input type="number" min={0} max={59} value={seconds} onChange={(e) => setSeconds(Math.max(0, Math.min(59, Number(e.target.value) || 0)))} className="tabular h-9 w-20 rounded-md border border-line bg-surface-2 px-2" aria-label="Sekunden" data-testid="timer-seconds" />
            s
          </div>
          <Button variant="primary" icon={Play} disabled={minutes * 60 + seconds === 0} onClick={() => startTimer((minutes * 60 + seconds) * 1000)} data-testid="timer-start">
            Starten
          </Button>
        </>
      )}
    </div>
  );
}

function Stopwatch() {
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [laps, setLaps] = useState<number[]>([]);
  const startRef = useRef(0);
  useNow(running ? 50 : 100_000);
  const current = running ? elapsed + (Date.now() - startRef.current) : elapsed;
  const toggle = () => {
    if (running) {
      setElapsed(current);
      setRunning(false);
    } else {
      startRef.current = Date.now();
      setRunning(true);
    }
  };
  return (
    <div className="flex flex-col items-center gap-5 p-5">
      <div className="tabular text-6xl font-light" data-testid="stopwatch">
        {formatDuration(current, true)}
      </div>
      <div className="flex gap-2">
        <Button variant="primary" icon={running ? Pause : Play} onClick={toggle} data-testid="stopwatch-toggle">
          {running ? 'Anhalten' : current ? 'Weiter' : 'Start'}
        </Button>
        <Button icon={Flag} disabled={!running} onClick={() => setLaps((l) => [current, ...l])}>
          Runde
        </Button>
        <Button
          icon={RotateCcw}
          disabled={running || !current}
          onClick={() => {
            setElapsed(0);
            setLaps([]);
          }}
        >
          Zurücksetzen
        </Button>
      </div>
      <div className="w-full max-w-sm divide-y divide-line-soft">
        {laps.map((lap, i) => (
          <div key={i} className="tabular flex justify-between py-1.5 text-sm">
            <span className="text-fg-muted">Runde {laps.length - i}</span>
            <span>{formatDuration(lap - (laps[i + 1] ?? 0), true)}</span>
            <span className="text-fg-subtle">{formatDuration(lap, true)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const TABS: Array<{ id: Tab; label: string; icon: typeof Clock3 }> = [
  { id: 'world', label: 'Weltuhr', icon: Globe2 },
  { id: 'alarm', label: 'Wecker', icon: AlarmClock },
  { id: 'timer', label: 'Timer', icon: Hourglass },
  { id: 'stopwatch', label: 'Stoppuhr', icon: Timer },
];

export default function ClockApp({ payload }: AppProps) {
  const [tab, setTab] = useState<Tab>(typeof payload?.tab === 'string' && TABS.some((t) => t.id === payload.tab) ? (payload.tab as Tab) : 'world');
  return (
    <div className="flex h-full flex-col bg-surface-1" data-testid="clock">
      <div className="flex justify-center gap-1 border-b border-line-soft p-2" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm', tab === t.id ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-surface-2')}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>
      <div className="scroll-area min-h-0 flex-1 overflow-auto">
        {tab === 'world' ? <WorldClock /> : tab === 'alarm' ? <Alarms /> : tab === 'timer' ? <TimerTab /> : <Stopwatch />}
      </div>
    </div>
  );
}
