import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createDemo } from '../docs/engine.mjs';
import { createCashDemo } from '../docs/phase-two-demo.mjs';
import { buildFreeeCsv, freeeJournalColumns } from '../docs/freee-export.mjs';
import { getReportPeriod } from '../docs/report-period.mjs';

const first = '2026-11-16';
const second = '2026-11-17';
const timestamp = Date.parse('2026-11-16T22:00+09:00');
const mixed = {
  number:101, status:'departed',
  deposits:[{method:'cash',amount:2000}],
  payments:[{method:'cash',amount:1000},{method:'card',amount:1200},{method:'qr',amount:4000},{method:'receivable',amount:5000}],
  settlement:{total:13200,taxBreakdown:[
    {rate:1000,base:10000,tax:1000},{rate:800,base:1000,tax:80},{rate:0,base:1120,tax:0},
  ]},
};
const other = {
  number:103, status:'paid', deposits:[], payments:[{method:'cash',amount:1100}],
  settlement:{total:1100,taxBreakdown:[{rate:1000,base:1000,tax:100}]},
};
const cancelled = { ...other, number:104, status:'cancelled' };
const period = { valid:true, days:[
  {date:first,current:{sales:14_300},settledTickets:[mixed,other,cancelled],ticketDataComplete:true},
  {date:second,current:{sales:1_100},settledTickets:[other],ticketDataComplete:true},
]};
const options = {storeName:'検証店',storeId:'store-test'};

function rows(csv) {
  assert(csv.startsWith('\uFEFF[表題行]'));
  assert(csv.endsWith('\r\n'));
  return csv.slice(1).split('\r\n').slice(0,-1).map((line) => line.split(','));
}

function groups(records) {
  const journals = new Map();
  for (const row of records) {
    if (!journals.has(row[2])) journals.set(row[2], []);
    journals.get(row[2]).push(row);
  }
  return [...journals.values()];
}

test('daily generic-journal export keeps each day balanced and uses the official 16 selected columns', () => {
  const result = buildFreeeCsv(period,{...options,mode:'daily'});
  const [header,...records] = rows(result.csv);
  assert.deepEqual(header,freeeJournalColumns);
  assert.equal(header.length,16);
  assert.equal(result.journalCount,2);
  assert.equal(result.salesTotal,15_400);
  assert(records.every((row) => row.length === 16 && row[0] === '[明細行]' && /^\d{15}$/.test(row[2])));
  const [firstDay, nextDay] = groups(records);
  assert.equal(firstDay.length,5);
  assert.notEqual(firstDay[0][2], nextDay[0][2]);
  assert(firstDay.every((row) => row[1] === '2026/11/16'));
  assert.equal(nextDay[0][1],'2026/11/17');
  assert.deepEqual(firstDay.map((row) => [row[4],row[7],row[8],row[9]]),[
    ['現金','2100','対象外','0'],['未収入金','1200','対象外','0'],['未収入金','4000','対象外','0'],
    ['売掛金','5000','対象外','0'],['前受金','2000','対象外','0'],
  ]);
  assert.deepEqual(firstDay.map((row) => [row[10],row[12],row[13],row[14]]),[
    ['売上高','12100','課税売上10%','1100'],['売上高','1080','課税売上8%（軽）','80'],
    ['売上高','1120','非課売上','0'],['','','',''],['','','',''],
  ]);
  assert(firstDay[0][15].includes('検証店｜日次売上'));
  assert(firstDay[0][15].includes('カード 1200円／QR決済 4000円'));
  for (const group of [firstDay,nextDay]) {
    const sumColumn = (index) => group.reduce((total,row) => total + Number(row[index]),0);
    assert.equal(sumColumn(7),sumColumn(12));
  }
});

test('ticket mode keeps sale-level taxes, excludes cancelled receipts and namespaces stable reference numbers', () => {
  const result = buildFreeeCsv(period,{...options,mode:'tickets'});
  const [, ...records] = rows(result.csv);
  const journals = groups(records);
  assert.equal(result.journalCount,3);
  assert.equal(result.salesTotal,15_400);
  assert.equal(journals.length,3);
  assert(!records.some((row) => row[15].includes('伝票 No. 104')));
  assert(journals[0][0][15].includes('伝票 No. 101'));
  const subset = {valid:true,days:[period.days[1]]};
  const lastLine = rows(buildFreeeCsv(subset,{...options,mode:'tickets'}).csv)[1];
  assert.equal(lastLine[2],journals[2][0][2]);
  const fromAnotherStore = rows(buildFreeeCsv(subset,{...options,storeId:'other',mode:'tickets'}).csv)[1];
  assert.notEqual(lastLine[2],fromAnotherStore[2]);
  assert(buildFreeeCsv(subset,{...options,storeName:'検証, "本店"',mode:'tickets'}).csv
    .includes('"NP POS｜検証, ""本店""｜伝票 No. 103｜現金 1100円"'));
});

test('incomplete, unbalanced or unknown fiscal detail blocks both exports', () => {
  const only = (ticket, complete=true) => ({valid:true,days:[
    {date:first,current:{sales:13200},settledTickets:ticket ? [ticket] : [],ticketDataComplete:complete},
  ]});
  for (const mode of ['daily','tickets']) {
    const build = (data) => buildFreeeCsv(data,{...options,mode});
    assert.throws(() => build(only(null,false)), /2026-11-16.*明細が不足/);
    assert.throws(() => build(only({...mixed,settlement:{total:13200}})), /税率別内訳がない/);
    assert.throws(() => build(only({...mixed,payments:[]})), /支払内訳と会計額が一致しない/);
    assert.throws(() => build(only({...mixed,settlement:{total:13200,taxBreakdown:[
      {rate:500,base:13000,tax:200},
    ]}})), /10%、軽減8%、非課税/);
    const zero = build({valid:true,days:[{date:first,current:{sales:0},settledTickets:[]}]});
    assert.equal(zero.journalCount,0);
    assert.equal(zero.salesTotal,0);
    assert.equal(rows(zero.csv).length,1);
  }
});

test('older zero-sales archives with missing details do not block the export of other days', () => {
  const data = {valid:true,days:[
    {date:first,current:{sales:0},settledTickets:[],ticketDataComplete:false},
    period.days[1],
  ]};
  for (const mode of ['daily','tickets']) {
    const result = buildFreeeCsv(data,{...options,mode});
    assert.equal(result.journalCount,1);
    assert.equal(result.salesTotal,1100);
    assert(rows(result.csv).slice(1).every((row) => row[1] === '2026/11/17'));
  }
});

test('real settled checkout, recovery and expense keep the date-range freee sales tied to the report', () => {
  let source = createCashDemo(timestamp);
  source = apply(source,{type:'close',actualCash:29000},timestamp);
  source = apply(source,{type:'open',date:second,openingCash:10000},timestamp);
  source = apply(source,{type:'recoverReceivable',receivableId:source.receivables[0].id,amount:1200,method:'bank',date:second},timestamp);
  const view = getReportPeriod(source,{mode:'range',start:first,end:second});
  for (const mode of ['daily','tickets']) {
    const result = buildFreeeCsv(view,{...options,mode});
    const [, ...emitted] = rows(result.csv);
    assert.equal(result.salesTotal,view.totals.sales);
    assert.equal(result.salesTotal,13200);
    assert.equal(result.journalCount,1);
    assert(emitted.every((row) => row[1] === '2026/11/16'));
    assert(!result.csv.includes('レジロール'));
    assert(!result.csv.includes('山本'));
  }
  assert.equal(getReportPeriod(createDemo('closed',timestamp),{mode:'day',date:first}).totals.sales,0);
});
