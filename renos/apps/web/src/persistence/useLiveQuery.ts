import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';

/** Reaktive IndexedDB-Abfrage: Komponenten aktualisieren sich bei jeder Datenänderung automatisch. */
export function useLiveQuery<T>(query: () => Promise<T> | T, deps: unknown[], initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const subscription = liveQuery(query).subscribe({
      next: (result) => setValue(result),
      error: (error) => console.error('liveQuery failed', error),
    });
    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}
