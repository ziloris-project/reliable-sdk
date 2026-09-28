// IndexedDB wrapper for replay events. One object store, indexed by tab and
// timestamp for range queries, and by timestamp alone for pruning.
//
// Every tab of the same site shares one IndexedDB database, so each event is
// stored with the id of the tab that recorded it and reads only ever return
// one tab's events. Up to 1.4.x the store was shared with no tab key, so with
// two tabs open a replay interleaved the DOM events of both pages.
//
// All operations are fire-and-forget safe: if IDB is unavailable
// (incognito, storage pressure) the module degrades silently.

// A new database name rather than a version bump: an upgrade would block
// while any tab still runs an older SDK holding the old database open.
const DB_NAME = 'reliable_replay_v2';
const LEGACY_DB_NAME = 'reliable_replay';
const STORE_NAME = 'events';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { autoIncrement: true });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('tab_time', ['tab', 'timestamp'], { unique: false });
            }
        };

        req.onsuccess = () => {
            resolve(req.result);
            // The old shared buffer only ever held the last ~70 seconds; drop it.
            // If an old tab still has it open this waits until it closes.
            try { indexedDB.deleteDatabase(LEGACY_DB_NAME); } catch { /* ignore */ }
        };
        req.onerror = () => {
            dbPromise = null;
            reject(req.error);
        };
    });

    return dbPromise;
}

export interface StoredEvent {
    timestamp: number;
    /** Id of the tab that recorded the event (see replay/index.ts). */
    tab: string;
    data: unknown;
}

/** Append a batch of events to the store. */
export async function writeEvents(events: StoredEvent[]): Promise<void> {
    if (events.length === 0) return;
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const evt of events) {
        store.put(evt);
    }
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** Delete every tab's events with timestamp < cutoff. All tabs keep the same
 *  window, so any tab may prune for all of them. */
export async function pruneEvents(cutoff: number): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index('timestamp');
    const range = IDBKeyRange.upperBound(cutoff, true);
    const req = idx.openCursor(range);

    return new Promise((resolve, reject) => {
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** Read one tab's events within [startTs, endTs], in time order. */
export async function readEvents(tab: string, startTs: number, endTs: number): Promise<unknown[]> {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index('tab_time');
    const range = IDBKeyRange.bound([tab, startTs], [tab, endTs]);
    const results: unknown[] = [];

    return new Promise((resolve, reject) => {
        const req = idx.openCursor(range);
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                results.push((cursor.value as StoredEvent).data);
                cursor.continue();
            }
        };
        tx.oncomplete = () => resolve(results);
        tx.onerror = () => reject(tx.error);
    });
}

/** Clear all replay data. */
export async function clearAll(): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
