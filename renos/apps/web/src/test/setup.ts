import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';

// jsdom-Blobs lassen sich nicht per structuredClone in (fake-)IndexedDB speichern; im Browser gilt das nicht.
globalThis.Blob = NodeBlob as unknown as typeof Blob;
