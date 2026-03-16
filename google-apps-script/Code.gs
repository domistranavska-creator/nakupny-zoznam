const SPREADSHEET_ID = '158NnJJFeeZUxeB9D8tn001wPYMvmGNVNss4nQ_BGMYk';
const SHEET_NAME = 'NakupnyZoznam';
const TOMBSTONE_SHEET_NAME = 'NakupnyZoznam_deleted';

function doGet(e) {
  const action = getAction_(e);
  if (action === 'get' || action === 'load' || action === 'sync') {
    return jsonOutput_({ ok: true, items: readAllItems_() });
  }

  return jsonOutput_({
    ok: true,
    message: 'Shopping list sync is running.',
    items: readAllItems_()
  });
}

function doPost(e) {
  const payload = parsePayload_(e);
  const action = payload.action || getAction_(e);

  if (action === 'get' || action === 'load') {
    return jsonOutput_({ ok: true, items: readAllItems_() });
  }

  if (action === 'sync') {
    const items = normalizeItems_(payload.items);
    writeAllItems_(items);
    return jsonOutput_({ ok: true, items: readAllItems_() });
  }

  return jsonOutput_({
    ok: false,
    error: 'Unsupported action',
    supportedActions: ['get', 'load', 'sync']
  });
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

  ensureHeader_(sheet);

  if (hidden) {
    sheet.hideSheet();
  }

  return sheet;
}

function ensureHeader_(sheet) {
  const header = ['id', 'name', 'qty', 'bought', 'boughtAt', 'updatedAt', 'deleted'];
  const current = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  const needsHeader = header.some(function (value, index) {
    return current[index] !== value;
  });

  if (needsHeader) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
}

function readSheetItems_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
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
        deleted: row[6] === true || String(row[6]).toLowerCase() === 'true'
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
      item.deleted === true
    ];
  });

  sheet.clearContents();
  ensureHeader_(sheet);

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 7).setValues(rows);
  }
}

function readAllItems_() {
  const activeSheet = getSheet_(SHEET_NAME, false);
  const tombstoneSheet = getSheet_(TOMBSTONE_SHEET_NAME, true);
  return normalizeItems_(readSheetItems_(activeSheet).concat(readSheetItems_(tombstoneSheet)));
}

function writeAllItems_(items) {
  const normalized = normalizeItems_(items);
  const activeSheet = getSheet_(SHEET_NAME, false);
  const tombstoneSheet = getSheet_(TOMBSTONE_SHEET_NAME, true);

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
        deleted: item.deleted === true
      };

      const existing = merged.get(normalized.id);
      if (!existing) {
        merged.set(normalized.id, normalized);
        return;
      }

      const existingTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
      const normalizedTime = normalized.updatedAt ? new Date(normalized.updatedAt).getTime() : 0;
      if (normalizedTime >= existingTime) {
        merged.set(normalized.id, normalized);
      }
    });

  return Array.from(merged.values()).sort(function (a, b) {
    const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bTime - aTime;
  });
}
