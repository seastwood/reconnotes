import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

/** Local IndexedDB for things that are not Yjs documents. */
interface MetaDB extends DBSchema {
  texts: { key: string; value: { id: string; title: string; text: string } }
  blobs: { key: string; value: { id: string; blob: Blob; name: string; uploaded: boolean } }
}

let dbp: Promise<IDBPDatabase<MetaDB>> | null = null

export function metaDb() {
  dbp ??= openDB<MetaDB>('reconnotes-meta', 1, {
    upgrade(db) {
      db.createObjectStore('texts', { keyPath: 'id' })
      db.createObjectStore('blobs', { keyPath: 'id' })
    },
  })
  return dbp
}
