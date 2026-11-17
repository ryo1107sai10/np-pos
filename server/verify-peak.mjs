import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { apply, createDemo } from '../docs/engine.mjs';
import { applyCommand, createStore, inviteMember, listStores, migrateState, readState } from './database.mjs';

const configPath = fileURLToPath(new URL('../wrangler.jsonc',import.meta.url));
const require = createRequire(import.meta.url);
let wrangler;
try { wrangler = require('wrangler'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  const binary = execFileSync('npm',['exec','--offline','--package=wrangler','--','which','wrangler'],{encoding:'utf8'}).trim();
  wrangler = createRequire(realpathSync(binary))('wrangler');
}
const proxy = await wrangler.getPlatformProxy({configPath,persist:false,remoteBindings:false});

try {
  const {DB:db} = proxy.env;
  const schema = readFileSync(new URL('./schema.sql',import.meta.url),'utf8');
  const parser = new DatabaseSync(':memory:');
  let statements;
  try {
    parser.exec(schema);
    statements = parser.prepare('SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid').all();
  } finally { parser.close(); }
  await db.batch(statements.map(({sql}) => db.prepare(sql)));

  const operators = Array.from({length:5},(_,index) => ({uid:`peak-${index}`,email:`peak-${index}@example.test`}));
  const [owner,...staff] = operators;
  const {store:{id:storeId}} = await createStore(db,owner,'NP POS 負荷試験');
  for (const actor of staff) {
    await inviteMember(db,owner,storeId,actor.email,'staff');
    await listStores(db,actor);
  }
  const time = Date.now();
  let state = apply(createDemo('closed',time),{type:'open',openingCash:0},time);
  state.layoutAreas = ['フロア1','フロア2','フロア3'];
  state.tables = Array.from({length:30},(_,index) => ({id:`table-${crypto.randomUUID()}`,name:`卓${index + 1}`,
    area:state.layoutAreas[Math.floor(index / 10)],capacity:4,x:index % 10 % 4 * 3,y:Math.floor(index % 10 / 4) * 2}));
  for (const table of state.tables) state = apply(state,{type:'seat',tableIds:[table.id],guests:1,setId:'set60'},time);
  const {revision:start} = await migrateState(db,owner,storeId,{operationId:'peak-migration-fixture',snapshot:state});

  const durations = [];
  const rounds = 6;
  const orderCount = rounds * operators.length;
  for (let round = 0; round < rounds; round++) {
    const expectedRevision = start + round * operators.length;
    const ticketId = state.tickets[round === 0 ? 0 : round * 5].id;
    const results = await Promise.all(operators.map(async (actor,index) => {
      const began = performance.now();
      const currentTicket = round === 0 ? ticketId : state.tickets[round * 5 + index].id;
      const result = await applyCommand(db,actor,storeId,{operationId:`peak-round-${round}-actor-${index}`,
        expectedRevision,allowConcurrentOrder:true,command:{type:'order',ticketId:currentTicket,items:[{menuId:'highball',quantity:1,castIds:[]}]}});
      durations.push(performance.now() - began);
      return result.revision;
    }));
    assert.equal(new Set(results).size,operators.length);
  }
  const {revision,state:saved} = await readState(db,owner,storeId);
  assert.equal(revision,start + orderCount);
  assert.equal(saved.tickets.length,30);
  const lines = saved.tickets.flatMap(({lines}) => lines).filter(({menuId}) => menuId === 'highball');
  assert.equal(lines.length,orderCount);
  assert.equal(new Set(lines.map(({id}) => id)).size,orderCount);
  for (const {stockId,quantity} of state.menu.find(({id}) => id === 'highball').recipe) {
    assert.equal(saved.stock.find(({id}) => id === stockId).quantity,state.stock.find(({id}) => id === stockId).quantity - quantity * orderCount);
  }
  durations.sort((a,b) => a-b);
  console.log(JSON.stringify({environment:'local workerd D1',tables:saved.tickets.length,terminals:operators.length,
    committedOrders:lines.length,duplicateOrders:0,p50Ms:Math.round(durations[Math.ceil(durations.length * 0.5)-1]),
    p95Ms:Math.round(durations[Math.ceil(durations.length * 0.95)-1]),maxMs:Math.round(durations.at(-1))}));
} finally {
  await proxy.dispose();
}
