import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createService } from '../src/service.mjs';
import { createSource } from '../source.mjs';

const scenario = JSON.parse(await readFile(new URL('../scenario.json', import.meta.url), 'utf8'));

const loggerRoute = key => {
  const route = scenario.routes.find(candidate => candidate.path === '/logger/windows' &&
    candidate.query?.key === key);
  return route.steps.map(step => ({ ...step, key }));
};
const flatRoute = path => scenario.routes.find(candidate => candidate.path === path &&
  candidate.method === 'GET' && !candidate.query);

const scans = flatRoute('/scanner/events');
const clocks = flatRoute('/scanner/clocks');
const packing = flatRoute('/dock/packing');
const acceptances = flatRoute('/receiver/acceptances');

const loggerPhase = key => loggerRoute(key).map(step => step);

async function startService() {
  const service = createService();
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  const origin = 'http://127.0.0.1:' + service.server.address().port;
  const request = (path, options) => fetch(origin + path, options);
  const post = async (path, value) => {
    const response = await request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
    return { status: response.status, body: await response.json() };
  };
  return { service, request, post };
}

async function loadPhase(service, phase) {
  service.ingestScans({ events: scans.steps[phase], clocks: clocks.steps[phase] });
  service.ingestPacking({ packing: packing.steps[phase] });
  service.ingestAcceptances({ acceptances: acceptances.steps[phase] });
  const records = ['H71', 'H72', 'D5', 'D6'].map(key => loggerPhase(key)[phase]);
  service.ingestLoggers({ records });
}

const traceBody = {
  arrival: 'DL-95',
  units: ['C31', 'C32', 'C33', 'C34'],
  temperatureBandC: [2, 8],
  receiverPicklists: [
    { desk: '北棚', sheet: 'K-91', units: ['C31', 'C32'] },
    { desk: '西棚', sheet: 'K-95', units: ['C32', 'C33', 'C34'] },
  ],
};

test('逐托盘交代证据链、归属范围与当前处置', async t => {
  const { service, post } = await startService();
  t.after(() => service.server.close());
  await loadPhase(service, 0);
  const { status, body } = await post('/trace', traceBody);
  assert.equal(status, 200);
  const byUnit = new Map(body.units.map(unit => [unit.unit, unit]));

  // C31：原箱 → D5 换装台 → 新箱 三段都有可归属覆盖；
  // 北棚已记录 C31 的实际签收（acceptances），所以处置是“原交接依据可延续”。
  const c31 = byUnit.get('C31');
  assert.equal(c31.state, '有依据可放行');
  assert.deepEqual(c31.route.segments.map(segment => segment.role), ['origin', 'transfer', 'destination']);
  assert.deepEqual(c31.evidence.breaches, []);
  assert.equal(c31.custody.picklists[0].desk, '北棚');
  assert.deepEqual(c31.custody.acceptedBy, ['北棚']);
  assert.equal(c31.disposition.code, 'handover-continuing');

  // C32：箱封 H71 在 09:24–09:26 越限，但托盘 09:23 已卸出，越限不能算到它头上；
  // H72 与 D5 都覆盖良好，因此可放行。
  const c32 = byUnit.get('C32');
  assert.equal(c32.state, '有依据可放行');
  assert.equal(c32.evidence.breaches.length, 0);
  assert.ok(c32.evidence.notes.some(note => note.includes('不归属本托盘') || note.includes('不归属')));

  // C33/C34：D6 只有待归档段，H74 尚无记录；不能当成“已确认无记录”。
  for (const unit of ['C33', 'C34']) {
    const report = byUnit.get(unit);
    assert.equal(report.state, '尚缺覆盖');
    assert.ok(report.evidence.blockers.includes('awaiting-archive'));
    assert.equal(report.disposition.code, 'hold-awaiting-archive');
    assert.ok(report.inquiries.some(inquiry => inquiry.action === 'await-archive' && inquiry.key === 'D6'));
  }

  // 同一到达批可以分给不同收货台，各按其拣货单领取
  assert.deepEqual(body.receivers.map(receiver => receiver.desk), ['北棚', '西棚']);
  const west = body.receivers.find(receiver => receiver.desk === '西棚');
  assert.deepEqual(west.claimable, ['C32']);
  assert.deepEqual(west.notClaimable.map(item => item.unit).sort(), ['C33', 'C34']);
  assert.equal(body.summary.releasable.includes('C32'), true);
});

test('阶段切换：D6 归档后给出越限，已发凭据按实际持有人处置', async t => {
  const { service, post } = await startService();
  t.after(() => service.server.close());
  await loadPhase(service, 0);
  const first = await post('/trace', traceBody);
  assert.equal(first.status, 200);

  const receipt = await post('/receipts', {
    requestKey: '北棚-放行-1', desk: '北棚', sheet: 'K-91', units: ['C31', 'C32'],
    arrival: 'DL-95', finding: '放行',
  });
  assert.equal(receipt.status, 201);

  await loadPhase(service, 1);
  const second = await post('/trace', traceBody);
  const byUnit = new Map(second.body.units.map(unit => [unit.unit, unit]));

  // C32 在修订后并入 T5/D6；D6 归档读数为 10℃，越过 2–8℃
  assert.equal(byUnit.get('C32').state, '越限');
  assert.equal(byUnit.get('C33').state, '越限');
  assert.equal(byUnit.get('C31').state, '有依据可放行');

  const report = second.body.receipts.find(item => item.requestKey === '北棚-放行-1');
  assert.deepEqual(report.acceptedUnits, ['C31']);
  assert.deepEqual(report.unacceptedUnits, ['C32']);
  assert.deepEqual(report.routeChangedUnits, ['C32']);
  assert.equal(report.laterHandoffs[0].desk, '西棚');
  const recall = report.actions.find(action => action.type === 'notify-recall');
  assert.equal(recall.party, '西棚');

  // 已核实且仍在正确路段上的记录沿用，只有路段真的变了的才作废
  const reused = second.body.claims.reused.map(item => item.unit + '/' + item.role + '/' + item.key);
  assert.ok(reused.includes('C31/origin/H71'));
  assert.ok(reused.includes('C32/origin/H71'));
  assert.ok(!reused.includes('C32/transfer/D5'));
  const reacquired = second.body.claims.reacquired.map(item => item.unit + '/' + item.role + '/' + item.key);
  assert.ok(reacquired.includes('C32/transfer/D6'));
});

test('校时精度不足时不出具两份互相矛盾的证明', async t => {
  const { service, post } = await startService();
  t.after(() => service.server.close());
  service.ingestScans({
    events: scans.steps[0].map(event => ({ ...event, clockProof: 'KX' })),
    clocks: [{ id: 'KX', offsetSeconds: 0, uncertaintySeconds: 300 }],
  });
  service.ingestPacking({ packing: packing.steps[0] });
  service.ingestLoggers({
    records: [
      { ...loggerPhase('H71')[0] },
      { ...loggerPhase('H72')[0] },
      { ...loggerPhase('D5')[0] },
    ],
  });
  const { body } = await post('/trace', { ...traceBody, units: ['C31'] });
  const unit = body.units[0];
  assert.equal(unit.state, '待认定');
  assert.equal(unit.disposition.code, 'hold-await-identification');
  assert.ok(unit.route.exit && unit.route.enter);
  assert.ok(unit.evidence.conflicts.some(conflict => conflict.kind === 'order-uncertain'));
  assert.ok(unit.inquiries.some(inquiry => inquiry.action === 'request-clock-proof'));
  // 换装台独立温控不用于顺序不明的托盘：该段只登记窗口，不出证明
  const transfer = unit.route.segments.find(segment => segment.role === 'transfer');
  assert.equal(transfer.verdict, '待认定');
  assert.equal(transfer.applies, false);
  assert.deepEqual(transfer.breaches, []);
});

test('两处收货台对同一货件都记录接手时，标明受影响货件与取证方向', async t => {
  const { service, post } = await startService();
  t.after(() => service.server.close());
  await loadPhase(service, 0);
  service.ingestAcceptances({
    acceptances: [
      { desk: '北棚', sheet: 'K-91', claimId: 'B10', units: ['C31'], arrival: 'DL-95' },
      { desk: '西棚', sheet: 'K-95', claimId: 'W11', units: ['C31'], arrival: 'DL-95' },
    ],
  });
  const { body } = await post('/trace', { ...traceBody, units: ['C31'] });
  const unit = body.units[0];
  assert.equal(unit.custody.acceptedBy.length, 2);
  assert.equal(unit.disposition.code, 'conflict-hold');
  assert.deepEqual(unit.custody.conflict.inquire.sort(), ['北棚', '西棚']);
  assert.ok(body.conflicts.some(conflict => conflict.kind === 'acceptance-conflict'));
});

test('收货台只收其中若干货件时，未收部分仍可稍后交另一台', async t => {
  const { service, post } = await startService();
  t.after(() => service.server.close());
  await loadPhase(service, 0);
  await post('/receipts', {
    requestKey: '北棚-放行-2', desk: '北棚', sheet: 'K-91', units: ['C31', 'C32'],
    arrival: 'DL-95', finding: '放行',
  });
  service.ingestAcceptances({
    acceptances: [{ desk: '北棚', sheet: 'K-91', claimId: 'B10', units: ['C31'], arrival: 'DL-95' }],
  });
  const { body } = await post('/trace', traceBody);
  const report = body.receipts.find(item => item.requestKey === '北棚-放行-2');
  assert.deepEqual(report.acceptedUnits, ['C31']);
  assert.deepEqual(report.unacceptedUnits, ['C32']);
  const c32 = body.units.find(unit => unit.unit === 'C32');
  assert.equal(c32.custody.unclaimed, true);
  assert.equal(c32.disposition.code, 'release-unsigned');
});

test('待归档段会随按窗口补领而变化，补领后能区分越限与可放行', async t => {
  const { service, post } = await startService();
  t.after(() => service.server.close());
  service.ingestScans({ events: scans.steps[0], clocks: clocks.steps[0] });
  service.ingestPacking({ packing: packing.steps[1] });
  service.ingestLoggers({
    records: [loggerPhase('H71')[0], loggerPhase('H72')[0], loggerPhase('D5')[0], loggerPhase('D6')[0]],
  });
  const before = await post('/trace', { ...traceBody, units: ['C33'] });
  assert.equal(before.body.units[0].state, '尚缺覆盖');
  assert.ok(before.body.units[0].evidence.blockers.includes('awaiting-archive'));

  const sources = createSource().listen(0, '127.0.0.1');
  await once(sources, 'listening');
  const sourceUrl = 'http://127.0.0.1:' + sources.address().port;
  await fetch(sourceUrl + '/replay/phase', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"phase":1}',
  });
  const response = await fetch(sourceUrl + '/logger/windows?key=D6&from=09:23&to=09:29');
  const record = await response.json();
  sources.close();
  service.ingestLoggers({ records: [{ ...record, key: 'D6', window: { from: '09:23', to: '09:29' } }] });

  const after = await post('/trace', { ...traceBody, units: ['C33'] });
  const unit = after.body.units[0];
  assert.equal(unit.state, '越限');
  assert.equal(unit.evidence.blockers.includes('awaiting-archive'), false);
  assert.ok(unit.evidence.breaches.some(breach => breach.segment === 'transfer' && breach.key === 'D6'));
});

test('输入缺字段和未到货批的资料都给出明确错误，不伪造结论', async t => {
  const { service, post } = await startService();
  t.after(() => service.server.close());
  assert.equal((await post('/trace', { arrival: 'DL-95', units: [] })).status, 400);
  assert.equal((await post('/trace', { units: ['C31'] })).status, 400);
  const { status, body } = await post('/trace', { arrival: 'DL-95', units: ['Z99'], temperatureBandC: [2, 8] });
  assert.equal(status, 200);
  assert.equal(body.units[0].state, '尚缺覆盖');
  assert.equal(body.units[0].disposition.code, 'hold-route-unclear');
});
