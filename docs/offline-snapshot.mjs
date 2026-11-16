const databaseName = 'np-pos.offline-workspace.v1';
const bucket = 'workspaces';
export const offlineWorkspaceLifetime = 8 * 60 * 60 * 1_000;
const operationalRoles = new Set(['admin', 'manager', 'staff']);
const emptyCommission = { fixed: 0, rate: 0, points: 0 };

function pick(value, fields) {
  return Object.fromEntries(fields.filter((field) => value?.[field] !== undefined).map((field) => [field, value[field]]));
}

function projectPayment(payment) {
  return pick(payment, ['id', 'method', 'amount', 'at', 'brandId', 'brandName', 'baseAmount', 'cardFee',
    'cardFeeRateBps', 'feeWaived', 'waivedFeeRate', 'feeCutover']);
}

function projectLine(line) {
  return {
    ...pick(line, ['id', 'menuId', 'name', 'category', 'quantity', 'price', 'total', 'castIds', 'castNames', 'createdAt',
      'cancelledAt', 'providedAt', 'taxRate', 'originalTaxRate', 'serviceEligible', 'serviceExcluded', 'requiresCast',
      'autoExtension', 'extensionGroupId', 'lineDiscount', 'hideReceiptLine', 'printName']),
    stockUses: [], commission: emptyCommission,
  };
}

function projectTicket(ticket) {
  const settlement = ticket.settlement;
  return {
    ...pick(ticket, ['id', 'number', 'tableIds', 'tableLabels', 'guests', 'admittedGuests', 'createdAt', 'status',
      'endsAt', 'departedAt', 'settledAt', 'serviceRate', 'calculationSettings', 'discount', 'settlementRevision',
      'autoExtensionResumedAt', 'autoExtensionPausedAt', 'autoExtensionPauseSource']),
    customer: '',
    tableHistory: (ticket.tableHistory ?? []).map((row) => pick(row,['tableId','attachedAt','releasedAt'])),
    ...(ticket.discountRequest && { discountRequest: { id: ticket.discountRequest.id } }),
    lines: ticket.lines.map(projectLine),
    deposits: ticket.deposits.map(projectPayment),
    payments: ticket.payments.filter(({method}) => method !== 'receivable').map(projectPayment),
    settlement: !settlement ? null : {
      ...pick(settlement, ['subtotal', 'discount', 'lineDiscount', 'ticketDiscount', 'service', 'tax', 'total', 'deposit',
        'paid', 'remaining', 'cardFee', 'cardFeeTax', 'cardFeeRateBps', 'baseTotal', 'taxBreakdown', 'priceMode', 'depositFee', 'brandedFee']),
      commission: [], commissionDetails: [],
    },
  };
}

export function createOfflineWorkspace({ uid, store, revision, state, savedAt }) {
  if (!operationalRoles.has(store?.role) || !state?.day || !Array.isArray(state.tickets)
    || !Array.isArray(state.tables) || !Array.isArray(state.menu) || !Array.isArray(state.cast)
    || !Array.isArray(state.stock) || !Number.isSafeInteger(revision) || revision < 1) return null;
  const visiblePerson = (person) => pick(person, ['id', 'name', 'initials', 'color', 'enabled']);
  const visibleMenu = (item) => ({
    ...pick(item, ['id', 'name', 'category', 'subgroup', 'price', 'duration', 'popular', 'enabled', 'requiresCast',
      'barcode', 'taxRate', 'serviceEligible', 'printName', 'hideReceiptLine', 'acceptsCast']),
    ...(Array.isArray(item.recipe) && {recipe:item.recipe.map((row)=>pick(row,['stockId','quantity']))}),
    acceptsCast: item.acceptsCast || item.requiresCast || Object.values(item.commission ?? {}).some(Boolean)
      || state.cast.some((person) => person.enabled !== false && Object.values(person.commissionOverride ?? {}).some(Boolean)),
  });
  const table = (item) => pick(item, ['id', 'name', 'area', 'capacity', 'x', 'y']);
  return {
    uid, store: { ...pick(store, ['id', 'name', 'role', 'profileId']), hasState: true }, revision, savedAt,
    state: {
      ...pick(state, ['layoutAreas', 'nextId', 'nextTicket', 'calculationSettings', 'cardFeeSettings', 'registerSettings',
        'autoExtensionSettings', 'tableAutoExtension', 'initialSetSchedule', 'bulkExtensionEnabled', 'rolePolicy']),
      controls: pick(state.controls, ['castDutyMode']),
      day: { ...pick(state.day, ['status', 'date', 'openedAt', 'closedAt']), openingCash: 0, closingCash: null },
      tables: state.tables.map(table),
      archivedTables: (state.archivedTables ?? []).map(table),
      menu: state.menu.map(visibleMenu),
      cast: state.cast.map(visiblePerson),
      archivedCast: (state.archivedCast ?? []).map(visiblePerson),
      stock: state.stock.map((item) => ({
        ...pick(item, ['id', 'name', 'category', 'quantity', 'unit', 'minimum', 'hidden']),
        unitCost: 0, defaultUnitCost: 0, value: 0,
      })),
      tickets: state.tickets.filter(({status}) => status === 'open' || status === 'paid').map(projectTicket),
      closedDays: [], customers: [], movements: [],
    },
  };
}

export function usableOfflineWorkspace(record, { uid, storeId, now }) {
  return record?.uid === uid && record.store?.id === storeId && operationalRoles.has(record.store.role)
    && Number.isSafeInteger(record.revision) && record.revision > 0 && Number.isSafeInteger(record.savedAt)
    && record.savedAt <= now && now < record.savedAt + offlineWorkspaceLifetime
    && record.state?.day && ['tickets','tables','menu','cast','stock','movements','closedDays'].every((key) => Array.isArray(record.state[key]));
}

export function openOfflineWorkspaceCache(indexedDB) {
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

  async function transact(key, write, value) {
    const db = await database();
    return new Promise((resolve,reject) => {
      const transaction = db.transaction(bucket,write ? 'readwrite' : 'readonly');
      const store = transaction.objectStore(bucket);
      const request = write ? (value ? store.put(value,key) : store.delete(key)) : store.get(key);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error('Offline snapshot unavailable'));
    });
  }

  return {
    read: (key) => transact(key,false),
    write: (key,value) => transact(key,true,value),
  };
}
