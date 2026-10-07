/**
 * @OnlyCurrentDoc
 *
 * The line above is an instruction to Google, not a comment to tidy away: it limits this script
 * to the one spreadsheet it is attached to. Without it Google asks for every Sheet in the account.
 */

/**
 * Rosebay ordering demo — the shared order book (Google Apps Script web app).
 *
 * Two websites talk to this one script, and neither talks to the other:
 *   the ordering site  (mpc0367.github.io/rosebay-order-demo)  sends orders in and reads back its
 *                                                              own table's orders;
 *   the admin site     (mpc0367.github.io/rosebay-order-admin)  reads every order and moves each one
 *                                                              through the kitchen.
 * The Sheet is the record. Nothing else keeps the orders: close both sites and the Sheet still has
 * every one, in the order it arrived, with the time each status changed.
 *
 * The contract, in both directions. Replies are always JSON.
 *
 *   GET  ?key=<key>[&table=01][&since=<ISO>][&limit=200]
 *        -> { ok:true, orders:[ … ], serverTime:'<ISO>' }
 *
 *   POST (Content-Type text/plain, so the browser sends no preflight request — Apps Script
 *         cannot answer one), body is JSON:
 *     { key, action:'place', order:{ id, tableId, placedAt, lines:[{itemId,nameTh,nameEn,qty,unitTHB,variant}], totalTHB, note } }
 *        -> { ok:true, id }
 *     { key, action:'move', id, status }                 status ∈ accepted preparing ready served rejected cancelled
 *        -> { ok:true, id, status }
 *   On refusal: { ok:false, error:'<code>', detail:'<why>' }
 *
 * THE KEY IS NOT A SECRET. Both sites are public and carry it in their source, so anyone who reads
 * the page can read the key. It is a latch, not a lock: it keeps stray traffic and crawlers out of
 * the Sheet, and that is all it is for. What actually protects this demonstration is that it holds
 * nothing worth taking — invented orders, no guest names, no addresses, no payment. Never put a
 * real customer's details through it.
 *
 * Caps, so a loop or a bored visitor cannot fill the Sheet: at most 40 lines in one order, 200
 * orders read at a time, and a body of 64 KB. Rows are only ever appended or updated in place,
 * never deleted, so the Sheet stays a record of what happened.
 *
 * TO DEPLOY (seven steps, English then Thai)
 *   1. Open the Sheet, Extensions > Apps Script.
 *   2. Paste this whole file over Code.gs and save.
 *   3. Run `setupSheet` once. Google asks for permission: grant only
 *      "View and manage spreadsheets that this application has been installed in".
 *   4. Run `selfTest`. The log must end "selfTest: all checks passed".
 *   5. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
 *   6. Copy the Deployment ID; the address is https://script.google.com/macros/s/<id>/exec
 *   7. Read ORDERS_KEY from Project Settings > Script properties and put the address and the key
 *      into both sites' config.js.
 *
 *   1. เปิดชีต ไปที่ ส่วนขยาย (Extensions) > Apps Script
 *   2. วางไฟล์นี้ทับ Code.gs ทั้งไฟล์ แล้วบันทึก
 *   3. รัน `setupSheet` หนึ่งครั้ง Google จะขอสิทธิ์ ให้อนุญาตเฉพาะ
 *      "ดูและจัดการสเปรดชีตที่ติดตั้งแอปนี้ไว้" เท่านั้น
 *   4. รัน `selfTest` บันทึกต้องจบด้วย "selfTest: all checks passed"
 *   5. Deploy > New deployment > Web app · Execute as: Me · Who has access: Anyone
 *   6. คัดลอก Deployment ID ที่อยู่คือ https://script.google.com/macros/s/<id>/exec
 *   7. อ่าน ORDERS_KEY จาก Project Settings > Script properties แล้วใส่ที่อยู่กับคีย์
 *      ลงใน config.js ของทั้งสองเว็บไซต์
 */

var VERSION = 1;
var KIND = 'rosebay-orders';
var KEY_PROPERTY = 'ORDERS_KEY';
var KEY_OVERRIDE = '';                    // selfTest only; never set this by hand

var TAB = { orders: 'Orders', lines: 'Order lines', readme: 'Read me' };

var ORDER_COLUMNS = [
  'order_id', 'placed_at_iso', 'placed_at_bangkok', 'table', 'status',
  'items', 'total_thb', 'note', 'updated_at_iso', 'history',
];
var LINE_COLUMNS = [
  'order_id', 'placed_at_iso', 'table', 'item_id', 'name_th', 'name_en', 'variant',
  'qty', 'unit_thb', 'line_thb',
];

var STATUSES = ['submitted', 'accepted', 'preparing', 'ready', 'served', 'rejected', 'cancelled'];
var MOVABLE = ['accepted', 'preparing', 'ready', 'served', 'rejected', 'cancelled'];
var MAX_LINES = 40;
var MAX_BODY = 64 * 1024;
var MAX_READ = 200;
var ID_SHAPE = /^[A-Za-z0-9_-]{4,40}$/;
var ITEM_SHAPE = /^[a-z0-9][a-z0-9-]{0,79}$/;
var TABLE_SHAPE = /^[A-Za-z0-9 _-]{1,24}$/;

/* ── the two doors ────────────────────────────────────────────────────────────────────────── */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (!sameText_(String(p.key || ''), currentKey_())) return reply_({ ok: false, error: 'bad_key' });
    var limit = Math.min(MAX_READ, Math.max(1, Number(p.limit) || MAX_READ));
    var orders = readOrders_(String(p.table || ''), String(p.since || ''), limit);
    return reply_({ ok: true, kind: KIND, version: VERSION, orders: orders, serverTime: new Date().toISOString() });
  } catch (err) {
    return reply_({ ok: false, error: 'server_error', detail: clean_(String(err && err.message)) });
  }
}

function doPost(e) {
  var lock = LockService.getDocumentLock();
  var held = false;
  try {
    var raw = e && e.postData ? String(e.postData.contents || '') : '';
    if (raw.length > MAX_BODY) return reply_({ ok: false, error: 'too_big' });
    var body;
    try { body = JSON.parse(raw); } catch (parseErr) { return reply_({ ok: false, error: 'bad_json' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply_({ ok: false, error: 'bad_json' });
    if (!sameText_(String(body.key || ''), currentKey_())) return reply_({ ok: false, error: 'bad_key' });

    held = lock.tryLock(8000);
    if (!held) return reply_({ ok: false, error: 'busy' });

    if (body.action === 'place') return reply_(place_(body.order));
    if (body.action === 'move') return reply_(move_(body.id, body.status));
    return reply_({ ok: false, error: 'bad_action' });
  } catch (err) {
    return reply_({ ok: false, error: 'server_error', detail: clean_(String(err && err.message)) });
  } finally {
    if (held) lock.releaseLock();
  }
}

/* ── placing an order ─────────────────────────────────────────────────────────────────────── */

function place_(order) {
  var bad = checkOrder_(order);
  if (bad) return { ok: false, error: 'bad_order', detail: bad };

  var book = SpreadsheetApp.getActiveSpreadsheet();
  setupSheet();
  var orders = book.getSheetByName(TAB.orders);

  if (findRow_(orders, order.id) > 0) return { ok: true, id: order.id, already: true };

  var placed = new Date(order.placedAt);
  var nowIso = new Date().toISOString();
  var summary = order.lines.map(function (l) { return l.qty + '× ' + text_(l.nameEn || l.nameTh); }).join(', ');
  var history = JSON.stringify([{ status: 'submitted', at: order.placedAt }]);

  orders.appendRow([
    order.id, order.placedAt, Utilities.formatDate(placed, 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss'),
    text_(order.tableId), 'submitted', text_(summary), Number(order.totalTHB),
    text_(order.note || ''), nowIso, history,
  ]);

  var lines = book.getSheetByName(TAB.lines);
  var rows = order.lines.map(function (l) {
    return [
      order.id, order.placedAt, text_(order.tableId), l.itemId,
      text_(l.nameTh || ''), text_(l.nameEn || ''), text_(l.variant || ''),
      Number(l.qty), Number(l.unitTHB), Number(l.qty) * Number(l.unitTHB),
    ];
  });
  if (rows.length) lines.getRange(lines.getLastRow() + 1, 1, rows.length, LINE_COLUMNS.length).setValues(rows);

  stampReadMe_(book);
  SpreadsheetApp.flush();
  return { ok: true, id: order.id };
}

/* ── moving one along ─────────────────────────────────────────────────────────────────────── */

function move_(id, status) {
  if (!ID_SHAPE.test(String(id || ''))) return { ok: false, error: 'bad_id' };
  if (MOVABLE.indexOf(String(status)) < 0) return { ok: false, error: 'bad_status' };

  var book = SpreadsheetApp.getActiveSpreadsheet();
  var orders = book.getSheetByName(TAB.orders);
  if (!orders) return { ok: false, error: 'not_set_up' };
  var row = findRow_(orders, id);
  if (row < 1) return { ok: false, error: 'not_found' };

  var statusCol = ORDER_COLUMNS.indexOf('status') + 1;
  var historyCol = ORDER_COLUMNS.indexOf('history') + 1;
  var updatedCol = ORDER_COLUMNS.indexOf('updated_at_iso') + 1;
  var nowIso = new Date().toISOString();

  var history = [];
  try { history = JSON.parse(String(orders.getRange(row, historyCol).getValue() || '[]')); } catch (err) { history = []; }
  if (!Array.isArray(history)) history = [];
  history.push({ status: status, at: nowIso });

  orders.getRange(row, statusCol).setValue(status);
  orders.getRange(row, updatedCol).setValue(nowIso);
  orders.getRange(row, historyCol).setValue(JSON.stringify(history));
  stampReadMe_(book);
  SpreadsheetApp.flush();
  return { ok: true, id: id, status: status };
}

/* ── reading them back ────────────────────────────────────────────────────────────────────── */

function readOrders_(table, since, limit) {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var orders = book.getSheetByName(TAB.orders);
  var lines = book.getSheetByName(TAB.lines);
  if (!orders || orders.getLastRow() < 2) return [];

  var orderRows = orders.getRange(2, 1, orders.getLastRow() - 1, ORDER_COLUMNS.length).getValues();
  var lineRows = lines && lines.getLastRow() > 1
    ? lines.getRange(2, 1, lines.getLastRow() - 1, LINE_COLUMNS.length).getValues() : [];

  var linesById = {};
  for (var i = 0; i < lineRows.length; i++) {
    var lr = lineRows[i];
    var key = String(lr[0]);
    if (!linesById[key]) linesById[key] = [];
    linesById[key].push({
      itemId: String(lr[3]), nameTh: String(lr[4]), nameEn: String(lr[5]),
      variant: String(lr[6]) || null, qty: Number(lr[7]), unitTHB: Number(lr[8]),
    });
  }

  var out = [];
  for (var r = orderRows.length - 1; r >= 0 && out.length < limit; r--) {
    var row = orderRows[r];
    var id = String(row[0]);
    if (!id) continue;
    var placedAt = String(row[1]);
    if (table && String(row[3]) !== table) continue;
    if (since && placedAt <= since) continue;
    var history = [];
    try { history = JSON.parse(String(row[9] || '[]')); } catch (err) { history = []; }
    out.push({
      id: id, placedAt: placedAt, tableId: String(row[3]), status: String(row[4]),
      totalTHB: Number(row[6]), note: String(row[7]), updatedAt: String(row[8]),
      history: Array.isArray(history) ? history : [], lines: linesById[id] || [],
    });
  }
  return out;
}

/* ── checking what arrived ────────────────────────────────────────────────────────────────── */

function checkOrder_(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'no order';
  if (!ID_SHAPE.test(String(o.id || ''))) return 'id';
  if (!TABLE_SHAPE.test(String(o.tableId || ''))) return 'tableId';
  if (!isIsoTime_(String(o.placedAt || ''))) return 'placedAt';
  if (!Array.isArray(o.lines) || o.lines.length < 1) return 'lines';
  if (o.lines.length > MAX_LINES) return 'too many lines';
  var sum = 0;
  for (var i = 0; i < o.lines.length; i++) {
    var l = o.lines[i];
    if (!l || typeof l !== 'object') return 'line ' + i;
    if (!ITEM_SHAPE.test(String(l.itemId || ''))) return 'line ' + i + ' itemId';
    if (!isCount_(l.qty) || l.qty > 99) return 'line ' + i + ' qty';
    if (!isMoney_(l.unitTHB)) return 'line ' + i + ' unitTHB';
    if (startsLikeFormula_(l.nameTh) || startsLikeFormula_(l.nameEn) || startsLikeFormula_(l.variant)) return 'line ' + i + ' name';
    sum += Number(l.qty) * Number(l.unitTHB);
  }
  if (!isMoney_(o.totalTHB) || Math.abs(Number(o.totalTHB) - sum) > 0.5) return 'totalTHB';
  if (String(o.note || '').length > 300) return 'note';
  if (startsLikeFormula_(o.note) || startsLikeFormula_(o.tableId)) return 'formula';
  return null;
}

var isCount_ = function (v) { return typeof v === 'number' && isFinite(v) && v > 0 && v === Math.floor(v); };
var isMoney_ = function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 && v < 1000000; };
var startsLikeFormula_ = function (v) { return typeof v === 'string' && /^[=+]/.test(v.trim()); };

function isIsoTime_(s) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(s)) return false;
  var d = new Date(s);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 19) === s.slice(0, 19);
}

/** A spreadsheet runs a cell that opens with = or +. Text that could is stored with a leading '. */
function text_(v) {
  var s = String(v == null ? '' : v);
  return /^[=+]/.test(s.trim()) ? "'" + s : s;
}

var clean_ = function (s) { return String(s || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 200); };

/** Compares in constant time, so a wrong key tells nothing by how long the answer takes. */
function sameText_(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function findRow_(sheet, id) {
  if (!sheet || sheet.getLastRow() < 2) return -1;
  var ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

/* ── the key ──────────────────────────────────────────────────────────────────────────────── */

function currentKey_() {
  if (KEY_OVERRIDE) return KEY_OVERRIDE;
  return ensureKey_();
}

function ensureKey_() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty(KEY_PROPERTY);
  if (!key || key.length < 20) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 40);
    props.setProperty(KEY_PROPERTY, key);
  }
  return key;
}

/** Makes a new key. Both sites stop working until their config.js carries the new one. */
function rotateKey_() {
  PropertiesService.getScriptProperties().deleteProperty(KEY_PROPERTY);
  return ensureKey_();
}

/* ── the Sheet itself ─────────────────────────────────────────────────────────────────────── */

function setupSheet() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  ensureKey_();
  var names = [TAB.readme, TAB.orders, TAB.lines];
  for (var i = 0; i < names.length; i++) if (!book.getSheetByName(names[i])) book.insertSheet(names[i], i);

  var readme = book.getSheetByName(TAB.readme);
  if (String(readme.getRange('A1').getValue() || '') === '') {
    readme.getRange('A1:A6').setValues([
      ['Rosebay — the order book / สมุดออร์เดอร์'],
      ['Every order the ordering site sends lands here, and the admin site reads this Sheet. · ออร์เดอร์ทุกรายการจากหน้าสั่งอาหารมาที่นี่ และหน้าผู้ดูแลอ่านจากชีตนี้'],
      ['"Orders" and "Order lines" are written by the websites — do not edit them by hand. Rows are only added or updated, never deleted.'],
      ['A demonstration: invented orders, no guest names, no payment. · ตัวอย่างเท่านั้น ไม่มีชื่อลูกค้าและไม่มีการชำระเงินจริง'],
      ['Last written'],
      ['Orders so far'],
    ]);
    readme.getRange('A1').setFontWeight('bold');
    readme.setColumnWidth(1, 620);
  }

  headerRow_(book.getSheetByName(TAB.orders), ORDER_COLUMNS);
  headerRow_(book.getSheetByName(TAB.lines), LINE_COLUMNS);
  var first = book.getSheets()[0];
  if (first && ['Sheet1', 'แผ่น1'].indexOf(first.getName()) >= 0 && first.getLastRow() === 0) book.deleteSheet(first);
  SpreadsheetApp.flush();
  return 'ready';
}

function headerRow_(sheet, columns) {
  if (!sheet) return;
  if (sheet.getMaxColumns() < columns.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), columns.length - sheet.getMaxColumns());
  var head = sheet.getRange(1, 1, 1, columns.length);
  var now = head.getValues()[0];
  var same = true;
  for (var i = 0; i < columns.length; i++) if (String(now[i]) !== columns[i]) same = false;
  if (!same) head.setValues([columns]);
  head.setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function stampReadMe_(book) {
  var readme = book.getSheetByName(TAB.readme);
  var orders = book.getSheetByName(TAB.orders);
  if (!readme) return;
  readme.getRange('B5').setValue(new Date().toISOString());
  if (orders) readme.getRange('B6').setValue(Math.max(0, orders.getLastRow() - 1));
}

/* ── the self-test ────────────────────────────────────────────────────────────────────────── */

function selfTest() {
  var saved = KEY_OVERRIDE;
  KEY_OVERRIDE = 'self-test-key-0123456789';
  var failures = [];
  var good = {
    id: 'o-test-1234', tableId: '01', placedAt: '2026-01-01T10:00:00.000Z',
    lines: [{ itemId: 'g-latte', nameTh: 'ลาเต้', nameEn: 'Latte', variant: null, qty: 2, unitTHB: 90 }],
    totalTHB: 180, note: '',
  };
  var copy = function (change) { var c = JSON.parse(JSON.stringify(good)); change(c); return c; };
  var expect = function (label, order, want) {
    var got = checkOrder_(order);
    var ok = want === null ? got === null : (got !== null);
    if (!ok) failures.push(label + ': expected ' + want + ', got ' + got);
  };

  expect('a good order', good, null);
  expect('nothing at all', null, 'refused');
  expect('a list, not an object', [], 'refused');
  expect('no id', copy(function (c) { delete c.id; }), 'refused');
  expect('an id that is a pattern', copy(function (c) { c.id = 'a*b'; }), 'refused');
  expect('no table', copy(function (c) { c.tableId = ''; }), 'refused');
  expect('a table that is a formula', copy(function (c) { c.tableId = '=NOW()'; }), 'refused');
  expect('a time that is not one', copy(function (c) { c.placedAt = 'yesterday'; }), 'refused');
  expect('a date that does not exist', copy(function (c) { c.placedAt = '2026-02-30T10:00:00.000Z'; }), 'refused');
  expect('no lines', copy(function (c) { c.lines = []; }), 'refused');
  expect('a dish id that is a pattern', copy(function (c) { c.lines[0].itemId = 'g-*'; }), 'refused');
  expect('a fractional quantity', copy(function (c) { c.lines[0].qty = 1.5; }), 'refused');
  expect('a negative quantity', copy(function (c) { c.lines[0].qty = -1; }), 'refused');
  expect('a quantity as text', copy(function (c) { c.lines[0].qty = '2'; }), 'refused');
  expect('a price as text', copy(function (c) { c.lines[0].unitTHB = '90'; }), 'refused');
  expect('a total that does not add up', copy(function (c) { c.totalTHB = 5; }), 'refused');
  expect('a name that begins like a formula', copy(function (c) { c.lines[0].nameEn = '=1+1'; }), 'refused');
  expect('a note too long', copy(function (c) { c.note = new Array(320).join('x'); }), 'refused');
  expect('more lines than allowed', copy(function (c) { var l = []; for (var i = 0; i < 41; i++) l.push(c.lines[0]); c.lines = l; }), 'refused');

  if (text_('=SUM(A1)') !== "'=SUM(A1)") failures.push('text_ does not stop a formula');
  if (text_('Latte') !== 'Latte') failures.push('text_ changed ordinary text');
  if (!sameText_('abc', 'abc') || sameText_('abc', 'abd') || sameText_('abc', 'ab')) failures.push('sameText_ is wrong');
  if (!isIsoTime_('2026-01-01T10:00:00.000Z') || isIsoTime_('2026-13-01T10:00:00.000Z')) failures.push('isIsoTime_ is wrong');
  if (MOVABLE.indexOf('submitted') >= 0) failures.push('submitted must not be a move');
  if ('ก'.charCodeAt(0) !== 0x0E01 || '—'.charCodeAt(0) !== 0x2014) failures.push('the paste damaged the non-English text in this file: paste it again');

  KEY_OVERRIDE = saved;
  for (var i = 0; i < failures.length; i++) Logger.log('FAIL ' + failures[i]);
  Logger.log(failures.length === 0 ? 'selfTest: all checks passed' : 'selfTest: ' + failures.length + ' check(s) FAILED');
  return failures.length === 0;
}
