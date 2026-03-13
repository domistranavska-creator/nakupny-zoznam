const SPREADSHEET_ID = 'PASTE_SPREADSHEET_ID_HERE';
const SHEET_NAME = 'NakupnyZoznam';

function doGet(e) {
  const action = getAction_(e);
  if (action === 'get' || action === 'load' || action === 'sync') {
    return jsonOutput_({ ok: true, items: readItems_() });
  }

  return jsonOutput_({
    ok: true,
    message: 'Shopping list sync is running.',
    items: readItems_()
  });
}

function doPost(e) {
  const payload = parsePayload_(e);
  const action = payload.action || getAction_(e);

  if (action === 'get' || action === 'load') {
    return jsonOutput_({ ok: true, items: readItems_() });
  }

  if (action === 'sync') {
    const items = normalizeItems_(payload.items);
    writeItems_(items);
    return jsonOutput_({ ok: true, items: readItems_() });
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

function getSheet_() {
  if (!SPREADSHEET_ID || SPREADSHEET_ID === 'PASTE_SPREADSHEET_ID_HERE') {
    throw new Error('Set SPREADSHEET_ID in Code.gs before deployment.');
  }

  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
  }

  ensureHeader_(sheet);
  return sheet;
}

function ensureHeader_(sheet) {
  const header = ['id', 'name', 'qty', 'bought', 'boughtAt', 'updatedAt'];
  const current = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  const needsHeader = header.some(function (value, index) {
    return current[index] !== value;
  });

  if (needsHeader) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
}

function readItems_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  return values
    .filter(function (row) {
      return row[1];
    })
    .map(function (row) {
      return {
        id: String(row[0] || ''),
        name: String(row[1] || ''),
        qty: String(row[2] || ''),
        bought: row[3] === true || String(row[3]).toLowerCase() === 'true',
        boughtAt: row[4] ? new Date(row[4]).toISOString() : null
      };
    });
}

function writeItems_(items) {
  const sheet = getSheet_();
  const normalized = normalizeItems_(items);
  const rows = normalized.map(function (item) {
    return [
      item.id,
      item.name,
      item.qty,
      item.bought,
      item.boughtAt || '',
      new Date().toISOString()
    ];
  });

  sheet.clearContents();
  ensureHeader_(sheet);

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 6).setValues(rows);
  }
}

function normalizeItems_(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter(function (item) {
      return item && typeof item.name === 'string' && item.name.trim();
    })
    .map(function (item) {
      return {
        id: item.id ? String(item.id) : Utilities.getUuid(),
        name: String(item.name || '').trim(),
        qty: String(item.qty || '').trim(),
        bought: Boolean(item.bought),
        boughtAt: item.boughtAt ? String(item.boughtAt) : null
      };
    });
}
