import assert from 'node:assert/strict';
import test from 'node:test';
import { readDemoBackup, writeDemoBackup } from '../docs/demo-backup.mjs';
import { exportStoreConfiguration } from '../docs/engine.mjs';
import { createPayrollDemo } from '../docs/phase-two-demo.mjs';

const instant = Date.parse('2026-11-17T21:00:00+09:00');

test('demo backup preserves the complete snapshot including pay and audit on a clean restore', async () => {
  const input = createPayrollDemo(instant);
  assert.ok(input.tickets.length && input.auditLog.length && input.payroll.records.length);
  const text = await writeDemoBackup(input,instant);
  const backup = await readDemoBackup(text);
  assert.equal(backup.savedAt,new Date(instant).toISOString());
  assert.deepEqual(backup.snapshot,input);
});

test('demo backup rejects another file format, unknown versions and a changed financial amount', async () => {
  const sample = createPayrollDemo(instant);
  await assert.rejects(readDemoBackup(JSON.stringify(exportStoreConfiguration(sample))),/デモのバックアップ/);
  const content = JSON.parse(await writeDemoBackup(sample,instant));
  await assert.rejects(readDemoBackup(JSON.stringify({...content,version:2})),/対応していません/);
  content.snapshot.day.openingCash++;
  await assert.rejects(readDemoBackup(JSON.stringify(content)),/変更または破損/);
  sample.closedDays.push(null);
  await assert.rejects(writeDemoBackup(sample,instant),/読み取れません/);
});
