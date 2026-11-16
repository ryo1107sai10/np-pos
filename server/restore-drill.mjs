import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { apply, businessDate, createDemo, quote, summary } from '../docs/engine.mjs';
import { getLaborReport } from '../docs/labor-report.mjs';
import { applyCommand, changeMember, createStore, inviteMember, listAudit, listStores, migrateState, readState } from './database.mjs';
import { createStoreGroup, inviteGroupMember, setGroupStore } from './store-groups.mjs';

const sampleActors = {
  owner:{uid:'recovery-demo-owner',email:'restore-owner@example.test'},
  manager:{uid:'recovery-demo-manager',email:'restore-manager@example.test'},
  custom:{uid:'recovery-demo-custom',email:'restore-custom@example.test'},
  stranger:{uid:'recovery-demo-other',email:'restore-other@example.test'},
};
const fixtureName = 'np-pos-recovery-demo';
const schema = () => readFileSync(new URL('./schema.sql',import.meta.url),'utf8');

function databaseAdapter(sqlite) {
  return {
    prepare(sql) {
      const bind = (...parameters) => {
        const run = () => {
          const results = sqlite.prepare(sql).all(...parameters);
          return {results,meta:sqlite.prepare('SELECT changes() AS changes').get()};
        };
        return {run,all:async()=>run(),first:async()=>run().results[0] ?? null};
      };
      return {bind,...bind()};
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(({run})=>run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

export async function seedRecoveryFixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema());
  const db = databaseAdapter(sqlite);
  const {owner,manager,custom} = sampleActors;
  const storeId = (await createStore(db,owner,'復元検証店')).store.id;
  const otherStoreId = (await createStore(db,owner,'復元検証支店')).store.id;
  const groupId = (await createStoreGroup(db,owner,'復元検証グループ')).group.id;
  await setGroupStore(db,owner,groupId,storeId,true);
  await setGroupStore(db,owner,groupId,otherStoreId,true);
  await inviteGroupMember(db,owner,groupId,manager.email,'manager');
  await listStores(db,manager);
  await changeMember(db,owner,storeId,manager.uid);

  // Use synthetic multibyte text large enough to span the real application's persisted chunks.
  const customers = Array.from({length:480},(_,index)=>({name:`合成顧客${index}`,kana:'ごうせいこきゃく',
    memo:'架空の復元検証データ。'.repeat(32)}));
  const initial = apply(createDemo('closed'),{type:'importCustomers',customers});
  let current = await migrateState(db,owner,storeId,{operationId:crypto.randomUUID(),snapshot:initial});
  const step = async (command) => {
    const request = {operationId:crypto.randomUUID(),expectedRevision:current.revision,command};
    current = await applyCommand(db,owner,storeId,request);
    return request;
  };
  const date = businessDate();
  const profileId = 'role-' + crypto.randomUUID();
  await step({type:'saveRolePolicy',policy:{custom:{[profileId]:{label:'復元検証の注文担当',base:'manager',allowed:['addOrders']}}}});
  await inviteMember(db,owner,storeId,custom.email,profileId);
  await listStores(db,custom);
  await step({type:'open',date,openingCash:20_000});
  await step({type:'seat',tableIds:['a1'],guests:2,setId:'set60'});
  const {id:ticketId} = current.state.tickets[0];
  await step({type:'order',ticketId,items:[{menuId:'highball',quantity:2}]});
  const settlement = await step({type:'settle',ticketId,payments:[{method:'cash',amount:quote(current.state,ticketId).remaining}]});
  await step({type:'depart',ticketId});
  await step({type:'close',actualCash:summary(current.state).expectedCash});
  const month = date.slice(0,7);
  await step({type:'savePayrollRate',castId:'cast1',effectiveDate:date,hourlyRate:2400});
  await step({type:'savePayrollDraft',castId:'cast1',month,work:[{date,minutes:120}]});
  await step({type:'finalizePayroll',castId:'cast1',month});
  const priorDay = new Date(Date.parse(date) - 86_400_000).toISOString().slice(0,10);
  await step({type:'saveStaffPerson',name:'合成スタッフ',role:'manager',profileId,enabled:true});
  const {id:personId} = current.state.staffLabor.people[0];
  await step({type:'saveStaffRate',personId,effectiveDate:priorDay,hourlyRate:2500});
  await step({type:'saveStaffAttendance',personId,date:priorDay,clockInAt:Date.parse(`${priorDay}T20:00:00+09:00`),
    clockOutAt:Date.parse(`${priorDay}T23:00:00+09:00`),breakMinutes:30,reason:'バックアップ検証の合成勤怠'});
  assert.ok(sqlite.prepare('SELECT count(*) AS n FROM np_state_chunks WHERE store_id = ?').get(storeId).n > 1);
  const audit = await listAudit(db,owner,storeId);
  return {sqlite,expected:{storeId,otherStoreId,profileId,revision:current.revision,state:current.state,audit,settlement}};
}

export async function verifyRecovery(sqlite,expected) {
  assert.deepEqual(sqlite.prepare('PRAGMA integrity_check').all().map(({integrity_check})=>integrity_check),['ok']);
  assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
  const db = databaseAdapter(sqlite);
  const {owner,manager,custom,stranger} = sampleActors;
  const {storeId,otherStoreId,profileId,revision} = expected;
  const state = await readState(db,owner,storeId);
  assert.equal(state.revision,revision);
  assert.deepEqual(state.state,expected.state);
  const [staffAttendance] = state.state.staffLabor.attendance;
  assert.equal(getLaborReport(state.state,{start:staffAttendance.date,end:staffAttendance.date,role:profileId}).knownCost,6250);
  assert.deepEqual(await listAudit(db,owner,storeId),expected.audit);
  assert.ok(expected.audit.events.some(({action})=>action==='settle'));
  await assert.rejects(readState(db,manager,storeId),{code:'store-access'});
  assert.equal((await readState(db,manager,otherStoreId)).role,'manager');
  await assert.rejects(readState(db,stranger,storeId),{code:'store-access'});
  assert.equal((await readState(db,custom,storeId)).profileId,profileId);
  await assert.rejects(applyCommand(db,custom,storeId,{operationId:crypto.randomUUID(),expectedRevision:revision,
    command:{type:'open',date:businessDate(),openingCash:20000}}),{code:'forbidden'});
  assert.equal((await applyCommand(db,owner,storeId,expected.settlement)).revision,revision);
  assert.deepEqual(await listAudit(db,owner,storeId),expected.audit);
}

const identifier = (name) => `"${name.replaceAll('"','""')}"`;
const literal = (value) => value == null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replaceAll("'","''")}'`;

export function d1SeedSql(sqlite) {
  const objects = sqlite.prepare(`SELECT type,name,sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND (tbl_name GLOB 'np_*' OR tbl_name = 'd1_migrations') ORDER BY rowid`).all();
  const tables = objects.filter(({type})=>type === 'table');
  const definition = ({sql}) => `${sql.trimEnd().replace(/;$/,'')};`;
  const statements = tables.map(definition);
  for (const {name} of tables) {
    const table = identifier(name);
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all();
    const keys = columns.filter(({pk})=>pk).map(({name})=>name);
    const fields = columns.map(({name})=>identifier(name)).join(', ');
    for (const row of sqlite.prepare(`SELECT * FROM ${table}`).all()) {
      const splitFields = columns.filter(({name})=>!keys.includes(name) && typeof row[name] === 'string'
        && Buffer.byteLength(literal(row[name])) > 24_000).map(({name})=>name);
      const values = columns.map(({name})=>literal(splitFields.includes(name) ? '' : row[name])).join(', ');
      statements.push(`INSERT INTO ${table} (${fields}) VALUES (${values});`);
      const condition = keys.map((key)=>`${identifier(key)} = ${literal(row[key])}`).join(' AND ');
      for (const field of splitFields) {
        assert.ok(condition,'A large field needs a primary key for the split restore');
        const column = identifier(field);
        const characters = Array.from(row[field]);
        for (let offset=0;offset<characters.length;offset+=12_000) {
          const text = literal(characters.slice(offset,offset+12_000).join(''));
          statements.push(`UPDATE ${table} SET ${column} = ${column} || ${text} WHERE ${condition};`);
        }
      }
    }
  }
  statements.push(...objects.filter(({type})=>type !== 'table').map(definition));
  assert.ok(statements.every((line)=>Buffer.byteLength(line)<100_000),'D1 import statement is too long');
  return statements.join('\n');
}

function isolatedProject(parent,name) {
  const cwd = join(parent,name);
  mkdirSync(cwd);
  writeFileSync(join(cwd,'wrangler.jsonc'),JSON.stringify({name:fixtureName,compatibility_date:'2026-11-16',
    d1_databases:[{binding:'DB',database_name:fixtureName,database_id:crypto.randomUUID()}]}));
  return (...args) => execFileSync('npx',['--offline','wrangler','d1',...args,'--local'],{cwd,encoding:'utf8',timeout:60_000});
}

async function drill() {
  const {sqlite,expected} = await seedRecoveryFixture();
  const dir = mkdtempSync(join(tmpdir(),'np-pos-recovery-'));
  try {
    const source = isolatedProject(dir,'source');
    const target = isolatedProject(dir,'target');
    const path = (file)=>join(dir,file);
    writeFileSync(path('fixture.sql'),d1SeedSql(sqlite),{mode:0o600});
    source('execute',fixtureName,`--file=${path('fixture.sql')}`);
    source('export',fixtureName,`--output=${path('backup.sql')}`);
    const backup = new DatabaseSync(':memory:',{enableForeignKeyConstraints:false});
    backup.exec(readFileSync(path('backup.sql'),'utf8'));
    writeFileSync(path('restore.sql'),d1SeedSql(backup),{mode:0o600});
    backup.close();
    target('execute',fixtureName,`--file=${path('restore.sql')}`);
    target('export',fixtureName,`--output=${path('restored.sql')}`);
    const restored = new DatabaseSync(':memory:',{enableForeignKeyConstraints:false});
    try {
      restored.exec(readFileSync(path('restored.sql'),'utf8'));
      await verifyRecovery(restored,expected);
    } finally { restored.close(); }
    console.log('Restored an isolated D1 backup. Verified integrity, sales, inventory, payroll, labor, audit, role access, and checkout replay.');
  } finally {
    sqlite.close();
    rmSync(dir,{recursive:true,force:true});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await drill();
