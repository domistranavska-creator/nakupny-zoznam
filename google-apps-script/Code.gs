const SPREADSHEET_ID = '158NnJJFeeZUxeB9D8tn001wPYMvmGNVNss4nQ_BGMYk';
const SHEET_NAME = 'NakupnyZoznam';
const TOMBSTONE_SHEET_NAME = 'NakupnyZoznam_deleted';
const PACKING_SHEET_NAME = 'BalimeDovolenku';

function doGet(e) {
  const action = getAction_(e);
  if (action === 'get' || action === 'load' || action === 'sync') {
    return jsonOutput_(buildSyncPayload_());
  }

  return jsonOutput_(Object.assign({
    ok: true,
    message: 'Shopping list sync is running.'
  }, buildSyncPayload_()));
}

function doPost(e) {
  const payload = parsePayload_(e);
  const action = payload.action || getAction_(e);

  if (action === 'get' || action === 'load') {
    return jsonOutput_(buildSyncPayload_());
  }

  if (action === 'sync') {
    const nextItems = hasOwn_(payload, 'items')
      ? normalizeItems_(payload.items)
      : readAllItems_();
    const nextPacking = hasOwn_(payload, 'packing')
      ? normalizePacking_(payload.packing)
      : readPacking_();

    writeAllItems_(nextItems);
    writePacking_(nextPacking);

    return jsonOutput_(buildSyncPayload_());
  }

  return jsonOutput_({
    ok: false,
    error: 'Unsupported action',
    supportedActions: ['get', 'load', 'sync']
  });
}

function buildSyncPayload_() {
  return {
    ok: true,
    items: readAllItems_(),
    packing: readPacking_()
  };
}

function hasOwn_(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function getAction_(e) {
  return (e && e.parameter && e.parameter.action ? String(e.parameter.action) : '').toLowerCase();
}

function parsePayload_(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return {};
    }
    return JSON.parse(e.postData.contents);
  } catch (err) {
    return {};
  }
}

function jsonOutput_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet_() {
  if (!SPREADSHEET_ID || SPREADSHEET_ID === 'PASTE_SPREADSHEET_ID_HERE') {
    throw new Error('Set SPREADSHEET_ID in Code.gs before deployment.');
  }
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getSheet_(name, hidden) {
  const spreadsheet = getSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(name);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
  }

  if (hidden) {
    sheet.hideSheet();
  }

  return sheet;
}

function ensureShoppingHeader_(sheet) {
  const header = ['id', 'name', 'qty', 'bought', 'boughtAt', 'updatedAt', 'order', 'deleted', 'updatedById', 'updatedByType', 'updatedByLabel'];
  const current = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  const needsHeader = header.some(function (value, index) {
    return current[index] !== value;
  });

  if (needsHeader) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
}

function ensurePackingHeader_(sheet) {
  const header = ['kind', 'id', 'sectionId', 'name', 'packed', 'packedAt', 'updatedAt', 'order', 'deleted', 'updatedById', 'updatedByType', 'updatedByLabel'];
  const current = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  const needsHeader = header.some(function (value, index) {
    return current[index] !== value;
  });

  if (needsHeader) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
}

function getShoppingSheet_(name, hidden) {
  const sheet = getSheet_(name, hidden);
  ensureShoppingHeader_(sheet);
  return sheet;
}

function getPackingSheet_() {
  const sheet = getSheet_(PACKING_SHEET_NAME, true);
  ensurePackingHeader_(sheet);
  return sheet;
}

function readSheetItems_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  return values
    .filter(function (row) {
      return row[1];
    })
    .map(function (row) {
      return {
        id: String(row[0] || ''),
        name: String(row[1] || ''),
        qty: '',
        bought: row[3] === true || String(row[3]).toLowerCase() === 'true',
        boughtAt: row[4] ? new Date(row[4]).toISOString() : null,
        updatedAt: row[5] ? new Date(row[5]).toISOString() : '1970-01-01T00:00:00.000Z',
        order: Number.isFinite(Number(row[6])) ? Number(row[6]) : 0,
        deleted: row[7] === true || String(row[7]).toLowerCase() === 'true',
        updatedById: String(row[8] || ''),
        updatedByType: String(row[9] || ''),
        updatedByLabel: String(row[10] || '')
      };
    });
}

function writeSheetItems_(sheet, items) {
  const rows = items.map(function (item) {
    return [
      item.id,
      item.name,
      item.qty,
      item.bought,
      item.boughtAt || '',
      item.updatedAt || new Date().toISOString(),
      Number.isFinite(Number(item.order)) ? Number(item.order) : 0,
      item.deleted === true,
      item.updatedById || '',
      item.updatedByType || '',
      item.updatedByLabel || ''
    ];
  });

  sheet.clearContents();
  ensureShoppingHeader_(sheet);

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 11).setValues(rows);
  }
}

function readAllItems_() {
  const activeSheet = getShoppingSheet_(SHEET_NAME, false);
  const tombstoneSheet = getShoppingSheet_(TOMBSTONE_SHEET_NAME, true);
  return normalizeItems_(readSheetItems_(activeSheet).concat(readSheetItems_(tombstoneSheet)));
}

function writeAllItems_(items) {
  const normalized = normalizeItems_(items);
  const activeSheet = getShoppingSheet_(SHEET_NAME, false);
  const tombstoneSheet = getShoppingSheet_(TOMBSTONE_SHEET_NAME, true);

  writeSheetItems_(activeSheet, normalized.filter(function (item) {
    return item.deleted !== true;
  }));
  writeSheetItems_(tombstoneSheet, normalized.filter(function (item) {
    return item.deleted === true;
  }));
}

function normalizeItems_(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  const merged = new Map();
  items
    .filter(function (item) {
      return item && typeof item.name === 'string' && item.name.trim();
    })
    .forEach(function (item) {
      const normalized = {
        id: item.id ? String(item.id) : Utilities.getUuid(),
        name: String(item.name || '').trim(),
        qty: '',
        bought: Boolean(item.bought),
        boughtAt: item.boughtAt ? String(item.boughtAt) : null,
        updatedAt: item.updatedAt ? String(item.updatedAt) : '1970-01-01T00:00:00.000Z',
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : 0,
        deleted: item.deleted === true,
        updatedById: item.updatedById ? String(item.updatedById) : '',
        updatedByType: item.updatedByType ? String(item.updatedByType) : '',
        updatedByLabel: item.updatedByLabel ? String(item.updatedByLabel) : ''
      };

      const existing = merged.get(normalized.id);
      if (!existing) {
        merged.set(normalized.id, normalized);
        return;
      }

      if (timestampMs_(normalized.updatedAt) >= timestampMs_(existing.updatedAt)) {
        merged.set(normalized.id, normalized);
      }
    });

  return Array.from(merged.values()).sort(sortByOrderThenUpdatedDesc_);
}

function readPacking_() {
  const sheet = getPackingSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return { sections: [], items: [] };
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
  const sections = [];
  const items = [];

  values.forEach(function (row) {
    const kind = String(row[0] || '').toLowerCase();
    if (kind === 'section') {
      sections.push({
        id: String(row[1] || ''),
        name: String(row[3] || ''),
        order: Number.isFinite(Number(row[7])) ? Number(row[7]) : 0,
        deleted: row[8] === true || String(row[8]).toLowerCase() === 'true',
        updatedAt: row[6] ? new Date(row[6]).toISOString() : '1970-01-01T00:00:00.000Z',
        updatedById: String(row[9] || ''),
        updatedByType: String(row[10] || ''),
        updatedByLabel: String(row[11] || '')
      });
      return;
    }

    if (kind === 'item') {
      items.push({
        id: String(row[1] || ''),
        sectionId: String(row[2] || ''),
        name: String(row[3] || ''),
        packed: row[4] === true || String(row[4]).toLowerCase() === 'true',
        packedAt: row[5] ? new Date(row[5]).toISOString() : null,
        updatedAt: row[6] ? new Date(row[6]).toISOString() : '1970-01-01T00:00:00.000Z',
        order: Number.isFinite(Number(row[7])) ? Number(row[7]) : 0,
        deleted: row[8] === true || String(row[8]).toLowerCase() === 'true',
        updatedById: String(row[9] || ''),
        updatedByType: String(row[10] || ''),
        updatedByLabel: String(row[11] || '')
      });
    }
  });

  return normalizePacking_({
    sections: sections,
    items: items
  });
}

function writePacking_(packing) {
  const normalized = normalizePacking_(packing);
  const sheet = getPackingSheet_();
  const rows = normalized.sections.map(function (section) {
    return [
      'section',
      section.id,
      '',
      section.name,
      false,
      '',
      section.updatedAt || new Date().toISOString(),
      Number.isFinite(Number(section.order)) ? Number(section.order) : 0,
      section.deleted === true,
      section.updatedById || '',
      section.updatedByType || '',
      section.updatedByLabel || ''
    ];
  }).concat(normalized.items.map(function (item) {
    return [
      'item',
      item.id,
      item.sectionId || '',
      item.name,
      item.packed === true,
      item.packedAt || '',
      item.updatedAt || new Date().toISOString(),
      Number.isFinite(Number(item.order)) ? Number(item.order) : 0,
      item.deleted === true,
      item.updatedById || '',
      item.updatedByType || '',
      item.updatedByLabel || ''
    ];
  }));

  sheet.clearContents();
  ensurePackingHeader_(sheet);

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 12).setValues(rows);
  }
}

function normalizePacking_(packing) {
  const sourceSections = packing && Array.isArray(packing.sections) ? packing.sections : [];
  const sourceItems = packing && Array.isArray(packing.items) ? packing.items : [];

  const mergedSections = new Map();
  sourceSections
    .filter(function (section) {
      return section && typeof section.name === 'string' && section.name.trim();
    })
    .forEach(function (section) {
      const normalized = {
        id: section.id ? String(section.id) : Utilities.getUuid(),
        name: String(section.name || '').trim(),
        order: Number.isFinite(Number(section.order)) ? Number(section.order) : 0,
        deleted: section.deleted === true,
        updatedAt: section.updatedAt ? String(section.updatedAt) : '1970-01-01T00:00:00.000Z',
        updatedById: section.updatedById ? String(section.updatedById) : '',
        updatedByType: section.updatedByType ? String(section.updatedByType) : '',
        updatedByLabel: section.updatedByLabel ? String(section.updatedByLabel) : ''
      };

      const existing = mergedSections.get(normalized.id);
      if (!existing || timestampMs_(normalized.updatedAt) >= timestampMs_(existing.updatedAt)) {
        mergedSections.set(normalized.id, normalized);
      }
    });

  const sections = Array.from(mergedSections.values()).sort(sortByOrderThenUpdatedDesc_);
  const knownSectionIds = new Set(sections.map(function (section) {
    return section.id;
  }));

  const mergedItems = new Map();
  sourceItems
    .filter(function (item) {
      return item && typeof item.name === 'string' && item.name.trim();
    })
    .forEach(function (item) {
      const normalized = {
        id: item.id ? String(item.id) : Utilities.getUuid(),
        sectionId: item.sectionId ? String(item.sectionId) : '',
        name: String(item.name || '').trim(),
        packed: item.packed === true,
        packedAt: item.packedAt ? String(item.packedAt) : null,
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : 0,
        deleted: item.deleted === true,
        updatedAt: item.updatedAt ? String(item.updatedAt) : '1970-01-01T00:00:00.000Z',
        updatedById: item.updatedById ? String(item.updatedById) : '',
        updatedByType: item.updatedByType ? String(item.updatedByType) : '',
        updatedByLabel: item.updatedByLabel ? String(item.updatedByLabel) : ''
      };

      if (!normalized.sectionId) {
        return;
      }

      const existing = mergedItems.get(normalized.id);
      if (!existing || timestampMs_(normalized.updatedAt) >= timestampMs_(existing.updatedAt)) {
        mergedItems.set(normalized.id, normalized);
      }
    });

  const items = Array.from(mergedItems.values())
    .filter(function (item) {
      return item.deleted === true || knownSectionIds.has(item.sectionId);
    })
    .sort(sortByOrderThenUpdatedDesc_);

  return {
    sections: sections,
    items: items
  };
}

function sortByOrderThenUpdatedDesc_(a, b) {
  const aOrder = Number.isFinite(Number(a.order)) ? Number(a.order) : 0;
  const bOrder = Number.isFinite(Number(b.order)) ? Number(b.order) : 0;
  if (aOrder !== bOrder) {
    return aOrder - bOrder;
  }

  return timestampMs_(b.updatedAt) - timestampMs_(a.updatedAt);
}

function timestampMs_(value) {
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}
