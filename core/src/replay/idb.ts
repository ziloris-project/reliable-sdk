// IndexedDB wrapper for replay events. Uses a single object store with
// a timestamp index for efficient range queries and pruning.
//
// All operations are fire-and-forget safe — if IDB is unavailable
// (incognito, storage pressure) the module degrades silently.

const DB_NAME = 'reliable_replay';
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
            }
        };

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
            dbPromise = null;
            reject(req.error);
        };
    });

    return dbPromise;
}

export interface StoredEvent {
    timestamp: number;
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

/** Delete all events with timestamp < cutoff. */
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

/** Read all events within [startTs, endTs]. */
export async function readEvents(startTs: number, endTs: number): Promise<unknown[]> {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index('timestamp');
    const range = IDBKeyRange.bound(startTs, endTs);
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

/** Delete events in a specific range (after successful flush). */
export async function deleteRange(startTs: number, endTs: number): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index('timestamp');
    const range = IDBKeyRange.bound(startTs, endTs);

    return new Promise((resolve, reject) => {
        const req = idx.openCursor(range);
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
