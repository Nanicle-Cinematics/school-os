/**
 * The phone's copy of a register: a thin wrapper over IndexedDB.
 *
 * Browser only. Every function swallows its own failure and returns an empty
 * answer, because IndexedDB is simply absent in some private windows and can be
 * blocked by the browser: the register must still work online, and the worst
 * case offline is that it cannot be kept. `offlineAvailable()` tells a screen
 * whether to promise anything.
 *
 * What lives here is named in offline-register.ts, and so is how long it lives.
 * The rules that decide WHOSE it is and WHEN it goes are in `adoptOwner`,
 * `pruneStale` and `wipeAll`; nothing here reads the server.
 */
import {
  rollIsFresh,
  type OfflineEntry,
  type OfflineRoll,
} from "@/lib/offline-register";

const DB_NAME = "school-os-offline";
const DB_VERSION = 1;
const ROLLS = "rolls";
const REGISTERS = "registers";
const META = "meta";

export function offlineAvailable() {
  return typeof indexedDB !== "undefined";
}

function open(): Promise<IDBDatabase | null> {
  if (!offlineAvailable()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ROLLS)) db.createObjectStore(ROLLS, { keyPath: "classGroupId" });
        if (!db.objectStoreNames.contains(REGISTERS)) db.createObjectStore(REGISTERS, { keyPath: "key" });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "k" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Run one transaction and wait for it to COMMIT, not just for its last request. */
async function run<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => IDBRequest | void,
  fallback: T,
): Promise<T> {
  const db = await open();
  if (!db) return fallback;
  return new Promise<T>((resolve) => {
    try {
      const tx = db.transaction(stores, mode);
      let result: T = fallback;
      const request = work(tx);
      if (request) {
        request.onsuccess = () => {
          result = request.result as T;
        };
      }
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        resolve(fallback);
      };
    } catch {
      db.close();
      resolve(fallback);
    }
  });
}

export function saveRoll(roll: OfflineRoll) {
  return run<void>([ROLLS], "readwrite", (tx) => void tx.objectStore(ROLLS).put(roll), undefined);
}

export function getRoll(classGroupId: string) {
  return run<OfflineRoll | null>(
    [ROLLS],
    "readonly",
    (tx) => tx.objectStore(ROLLS).get(classGroupId),
    null,
  ).then((roll) => roll ?? null);
}

export function listRolls() {
  return run<OfflineRoll[]>([ROLLS], "readonly", (tx) => tx.objectStore(ROLLS).getAll(), []);
}

export function putEntry(entry: OfflineEntry) {
  return run<void>([REGISTERS], "readwrite", (tx) => void tx.objectStore(REGISTERS).put(entry), undefined);
}

export function getEntry(key: string) {
  return run<OfflineEntry | null>(
    [REGISTERS],
    "readonly",
    (tx) => tx.objectStore(REGISTERS).get(key),
    null,
  ).then((entry) => entry ?? null);
}

export function listEntries() {
  return run<OfflineEntry[]>([REGISTERS], "readonly", (tx) => tx.objectStore(REGISTERS).getAll(), []);
}

export function deleteEntry(key: string) {
  return run<void>([REGISTERS], "readwrite", (tx) => void tx.objectStore(REGISTERS).delete(key), undefined);
}

/** Replace the whole queue in one transaction, so a sync result lands all-or-nothing. */
export function replaceEntries(entries: OfflineEntry[]) {
  return run<void>(
    [REGISTERS],
    "readwrite",
    (tx) => {
      const store = tx.objectStore(REGISTERS);
      store.clear();
      for (const entry of entries) store.put(entry);
    },
    undefined,
  );
}

/** Everything on this phone, gone. Sign-out, and a different person signing in. */
export function wipeAll() {
  return run<void>(
    [ROLLS, REGISTERS, META],
    "readwrite",
    (tx) => {
      tx.objectStore(ROLLS).clear();
      tx.objectStore(REGISTERS).clear();
      tx.objectStore(META).clear();
    },
    undefined,
  );
}

type Owner = { k: "owner"; userId: string; schoolId: string };

/**
 * Make what is stored belong to the person using the phone now.
 *
 * Called whenever a signed-in page opens. If the last person to use this phone
 * was somebody else (or the same person at another school), their class list
 * and unsent registers are deleted BEFORE anything of the new person's is
 * written. Sign-out wipes too, but a session that simply expires never signs
 * out, so this is the check that actually protects the next person.
 */
export async function adoptOwner(who: { userId: string; schoolId: string }) {
  const stored = await run<Owner | null>([META], "readonly", (tx) => tx.objectStore(META).get("owner"), null);
  if (stored && (stored.userId !== who.userId || stored.schoolId !== who.schoolId)) {
    await wipeAll();
  }
  if (!stored || stored.userId !== who.userId || stored.schoolId !== who.schoolId) {
    await run<void>(
      [META],
      "readwrite",
      (tx) => void tx.objectStore(META).put({ k: "owner", ...who } satisfies Owner),
      undefined,
    );
  }
}

/** Drop class lists nobody has refreshed for a week, and drafts for days long gone. */
export async function pruneStale(now: Date) {
  const rolls = await listRolls();
  const stale = rolls.filter((roll) => !rollIsFresh(roll, now));
  const entries = await listEntries();
  const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  // A queued or failed register is the teacher's unsent work and is never
  // dropped here; only an abandoned draft is.
  const abandoned = entries.filter(
    (entry) => entry.status === "draft" && new Date(entry.updatedAt).getTime() < weekAgo,
  );
  if (stale.length === 0 && abandoned.length === 0) return;
  await run<void>(
    [ROLLS, REGISTERS],
    "readwrite",
    (tx) => {
      for (const roll of stale) tx.objectStore(ROLLS).delete(roll.classGroupId);
      for (const entry of abandoned) tx.objectStore(REGISTERS).delete(entry.key);
    },
    undefined,
  );
}
