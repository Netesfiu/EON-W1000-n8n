'use strict';

// Regression tests for the Excel-serial -> Spook hour conversion of the
// [Netesfiu] workflows. They run the real node code straight out of the
// workflow JSON, so a broken import can never ship because the template copy
// drifted from the tested one.
//
//   node --test tests/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const TEMPLATES = ['netesfiu/Alap-workflow.json', 'netesfiu/Alap-workflow_V2.json'];

const SLOT_KEY_NODE = 'Slot key: Excel serial + occurrence';
const CONVERT_NODE = 'Convert Excel time (DST-safe)';
const HOUR = 3600000;
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30); // Excel serial 0 == 1899-12-30

const load = (file) => JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));

const nodeCode = (workflow, name) => {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `node "${name}" is missing from the workflow`);
  return node.parameters.jsCode;
};

// n8n Code node semantics: the body has `items` in scope and returns items.
const runCode = (body, items) => new Function('items', body)(items);

// Excel serial of a wall clock (naive, no timezone involved).
const serialFor = (y, m, d, h = 0, min = 0) =>
  (Date.UTC(y, m - 1, d, h, min) - EXCEL_EPOCH_UTC) / 86400000;

/**
 * One scheduled E.ON export: `hours` hours at 15 minute resolution, starting at
 * the given wall clock. `repeatedHours` mimics the ambiguous fall-back hour,
 * which E.ON writes twice under the same serial.
 */
function buildSheet({ from, hours = 168, repeatedHours = [], valueAt }) {
  const rows = [];
  const startUtc = Date.UTC(from[0], from[1] - 1, from[2]);
  const first = serialFor(...from);
  // Always derive a serial from the same formula: E.ON repeats a serial
  // bit-for-bit, and a re-derived double could differ in the last bit.
  const serialAt = (quarter) => first + quarter / 96;
  const push = (serial, index) => {
    const base = valueAt(index);
    rows.push({
      Időbélyeg: serial,
      Érték: base,
      Érték_1: base / 10,
      Érték_2: index % 4 === 0 ? 42000 + index / 4 : null,
      Érték_3: index % 4 === 0 ? 49000 + index / 4 : null,
    });
  };

  for (let quarter = 0; quarter < hours * 4; quarter += 1) {
    push(serialAt(quarter), quarter);
  }
  repeatedHours.forEach((repeated, repeatedIndex) => {
    const wallUtc = Date.UTC(repeated[0], repeated[1] - 1, repeated[2], repeated[3] || 0);
    const quarter = Math.round((wallUtc - startUtc) / (HOUR / 4));
    for (let offset = 0; offset < 4; offset += 1) {
      // Same serial, different reading: the second pass through the hour.
      push(serialAt(quarter + offset), hours * 4 + repeatedIndex * 4 + offset);
    }
  });
  return rows;
}

const mergeBySlotKey = (keyed) => {
  const combine = (left, right) => {
    const out = [];
    for (const a of left) {
      for (const b of right) {
        if (String(a.json.start) !== String(b.json.start)) continue;
        out.push({ json: { ...a.json, ...b.json } });
      }
    }
    return out;
  };
  const stream = (column, as) =>
    keyed.map((item) => ({ json: { start: item.json['Időbélyeg'], [as]: item.json[column] } }));

  return combine(
    combine(combine(stream('Érték', 'AP'), stream('Érték_1', 'AM')), stream('Érték_2', '1_8_0')),
    stream('Érték_3', '2_8_0'),
  );
};

const convert = (workflow, rows) => {
  const keyed = runCode(nodeCode(workflow, SLOT_KEY_NODE), rows.map((json) => ({ json })));
  const merged = mergeBySlotKey(keyed);
  const converted = runCode(nodeCode(workflow, CONVERT_NODE), merged);
  const byHour = new Map();
  for (const { json } of converted) {
    const hour = byHour.get(json.start) || { AP: 0, AM: 0, rows: 0 };
    hour.AP += Number(json.AP) || 0;
    hour.AM += Number(json.AM) || 0;
    hour.rows += 1;
    byHour.set(json.start, hour);
  }
  const labels = [...byHour.keys()].sort((a, b) => Date.parse(a) - Date.parse(b));
  return { keyed, merged, converted, byHour, labels };
};

const total = (values) => values.reduce((sum, value) => sum + (Number(value) || 0), 0);

const assertContinuity = (labels) => {
  for (let i = 1; i < labels.length; i += 1) {
    assert.equal(
      Date.parse(labels[i]) - Date.parse(labels[i - 1]),
      HOUR,
      `hourly gap between ${labels[i - 1]} and ${labels[i]}`,
    );
  }
};

// ---------------------------------------------------------------------------

for (const template of TEMPLATES) {
  test(`${template}: no calendar/elapsed addToDate conversion left`, () => {
    const workflow = load(template);
    const names = workflow.nodes.map((node) => node.name);
    assert.ok(names.includes(SLOT_KEY_NODE));
    assert.ok(names.includes(CONVERT_NODE));
    assert.ok(!names.includes('Convert datetime to Spook format'));

    const addToDate = workflow.nodes.filter(
      (node) =>
        node.type === 'n8n-nodes-base.dateTime' &&
        /1899-12-30/.test(JSON.stringify(node.parameters)),
    );
    assert.deepEqual(addToDate, [], 'the Excel serial must not be converted with addToDate');

    const slotTargets = workflow.connections['Extract from File'].main[0].map((c) => c.node);
    assert.deepEqual(slotTargets, [SLOT_KEY_NODE], 'the slot key must run before the splits');
    assert.equal(workflow.connections[SLOT_KEY_NODE].main[0].length, 4, 'all four branches');
    assert.equal(workflow.connections['Convert Excel time (DST-safe)'].main[0].length, 1);
  });

  test(`${template}: DST fall-back week keeps all 169 hourly slots`, () => {
    const workflow = load(template);
    // Scheduled export 2026-10-20 00:00 -> 2026-10-26 23:45, spanning the
    // 2026-10-25 03:00 CEST -> 02:00 CET change, with the repeated hour.
    const rows = buildSheet({
      from: [2026, 10, 20],
      repeatedHours: [[2026, 10, 25, 2]],
      valueAt: (index) => 0.1 + (index % 17) * 0.01,
    });
    const { keyed, merged, converted, byHour, labels } = convert(workflow, rows);

    // A repeated serial must not fan out the four merge branches.
    assert.equal(new Set(keyed.map((item) => item.json['Időbélyeg'])).size, rows.length);
    assert.equal(merged.length, rows.length);
    assert.equal(converted.length, rows.length);

    assert.equal(labels.length, 169); // 168 hours + the repeated DST hour
    assertContinuity(labels);
    assert.equal(
      labels.filter((label) => label.startsWith('2026-10-25')).length,
      25,
      'the DST day has 25 local hours',
    );

    // Both passes of the ambiguous hour end up in their own slot, and the hour
    // that used to vanish (23:00) exists again.
    const firstPass = byHour.get('2026-10-25 02:00:00+02:00');
    const secondPass = byHour.get('2026-10-25 02:00:00+01:00');
    assert.ok(firstPass, 'first pass of the repeated hour');
    assert.ok(secondPass, 'second pass of the repeated hour');
    assert.ok(Math.abs(firstPass.AP - secondPass.AP) > 1e-9, 'passes must not be merged');
    assert.ok(byHour.get('2026-10-25 23:00:00+01:00'), 'the 23:00 hour must exist');
    assert.ok(byHour.get('2026-10-26 00:00:00+01:00'), 'the next midnight must follow 23:00');

    // Energy is neither duplicated nor lost.
    for (const hour of byHour.values()) assert.equal(hour.rows, 4);
    assert.ok(Math.abs(total(rows.map((row) => row.Érték)) - total(
      [...byHour.values()].map((hour) => hour.AP),
    )) < 1e-9);
  });

  test(`${template}: DST spring-forward week stays continuous`, () => {
    const workflow = load(template);
    // 2026-03-24 00:00 -> 2026-03-30 23:45 with the 02:00 -> 03:00 jump on the
    // 29th: the 02:00 wall-clock hour does not exist in Europe/Budapest.
    const rows = buildSheet({
      from: [2026, 3, 24],
      valueAt: (index) => 0.2 + (index % 11) * 0.01,
    });
    const { byHour, labels } = convert(workflow, rows);

    assertContinuity(labels);
    assert.ok(byHour.has('2026-03-24 00:00:00+01:00'));
    // The gap hour is folded forward instead of crashing or being dropped.
    assert.ok(byHour.has('2026-03-29 03:00:00+02:00'));
    assert.equal(labels.filter((label) => label.startsWith('2026-03-29')).length, 23);
    assert.ok(Math.abs(total(rows.map((row) => row.Érték)) - total(
      [...byHour.values()].map((hour) => hour.AP),
    )) < 1e-9);
  });

  test(`${template}: a week without a DST change keeps the wall clock`, () => {
    const workflow = load(template);
    const rows = buildSheet({
      from: [2026, 7, 6],
      valueAt: (index) => 0.3 + (index % 13) * 0.01,
    });
    const { byHour, labels, converted } = convert(workflow, rows);

    assert.equal(labels.length, 168);
    assert.equal(labels[0], '2026-07-06 00:00:00+02:00');
    assert.equal(labels[labels.length - 1], '2026-07-12 23:00:00+02:00');
    assertContinuity(labels);
    for (const hour of byHour.values()) assert.equal(hour.rows, 4);
    assert.equal(new Set(converted.map((item) => item.json.start)).size, 168);
  });
}

test('the slot key survives the JSON round-trip used by n8n', () => {
  // n8n stores numbers as JSON numbers and the key is a string; a serial that
  // does not round-trip would silently shift the row by up to an hour.
  const serial = 46320.083333333336;
  assert.equal(Number(`${serial}#1`.split('#')[0]), serial);
});
