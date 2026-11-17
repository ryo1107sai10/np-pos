const databaseName = 'np-pos.pending-operations.v1';
const bucket = 'storeQueues';
export const offlineCommands = new Set(['open','seat','order','extend','move','settle','depart','serve','close','changeCastRotation']);
export const offlineLimit = 30;

export function orderCanWait(queue, next) {
  if (!queue.length) return true;
  if (!offlineCommands.has(next?.type) || ['open','close'].includes(next.type)) return false;
  const tables = new Set(next.tableIds ?? []);
  return queue.every(({body}) => {
    const earlier = body.command;
    if (!earlier || ['open','close'].includes(earlier.type) || earlier.tableIds?.some((id) => tables.has(id))) return false;
    if (earlier.type === 'changeCastRotation' && next.type === 'changeCastRotation') return false;
    if (!earlier.ticketId || earlier.ticketId !== next.ticketId) return true;
    return earlier.type === 'order' && next.type === 'order';
  });
}

export function openOperationQueue(indexedDB) {
  let opening;
  function database() {
    if (!opening) {
      opening = new Promise((resolve,reject) => {
        if (!indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
        const request = indexedDB.open(databaseName,1);
        request.onupgradeneeded = () => request.result.createObjectStore(bucket);
        request.onsuccess = () => {
          const connection = request.result;
          connection.onversionchange = () => { connection.close(); opening = undefined; };
          resolve(connection);
        };
        request.onerror = () => reject(request.error);
      }).catch((error) => { opening = undefined; throw error; });
    }
    return opening;
  }
  return {
    async update(key, change) {
      const db = await database();
      return new Promise((resolve,reject) => {
        const transaction = db.transaction(bucket,change ? 'readwrite' : 'readonly');
        const store = transaction.objectStore(bucket);
        const request = store.get(key);
        let rows;
        let rejection;
        transaction.oncomplete = () => resolve(rows);
        transaction.onabort = () => reject(rejection ?? transaction.error ?? new Error('Queue unavailable'));
        request.onsuccess = () => {
          try {
            const saved = request.result ?? [];
            rows = change ? change(saved) : saved;
            if (change) {
              if (rows.length) store.put(rows,key);
              else store.delete(key);
            }
          } catch (error) {
            rejection = error;
            transaction.abort();
          }
        };
      });
    },
  };
}
