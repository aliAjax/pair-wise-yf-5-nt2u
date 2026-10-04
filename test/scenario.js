// 场景测试：排队调度 / 断网幂等 / 电价重算 / 月度对账
// 运行：node test/scenario.js
const assert = require('assert');
const { initDb } = require('../src/db');
const { ChargingOps } = require('../src/domain');

const db = initDb(':memory:');
const ops = new ChargingOps(db);

// 可注入时钟
let now = 0;
const T0 = Date.UTC(2026, 9, 4, 19, 30, 0); // 2026-10-04 19:30 UTC
ops._clock = () => now;

let seq = 0;
function freshStation(capacity = 100) {
  const s = ops.createStation('ST' + String(++seq).padStart(3, '0'), '中心站', capacity);
  const a = ops.addSpot(s.id, 'A');
  const b = ops.addSpot(s.id, 'B');
  const c = ops.addSpot(s.id, 'C');
  return { station: s, spotA: a, spotB: b, spotC: c };
}

let passed = 0;
function test(name, fn) {
  now = T0;
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('\n[1] 排队：一位一位补位（FIFO）+ 变压器容量');

test('同一位一次只跑一个会话，后到的排队', () => {
  const { station, spotA } = freshStation();
  const r1 = ops.startRequest(station.id, { spotId: spotA.id, requestId: 'r1', powerKw: 60 });
  assert.ok(r1.session && r1.session.status === 'active', 'r1 应立即开始');
  assert.equal(r1.session.spotId, spotA.id);

  const r2 = ops.startRequest(station.id, { spotId: spotA.id, requestId: 'r2', powerKw: 40 });
  assert.equal(r2.session, null, 'r2 应排队（A 忙）');
  assert.equal(r2.entry.status, 'waiting');

  const r3 = ops.startRequest(station.id, { spotId: spotA.id, requestId: 'r3', powerKw: 20 });
  assert.equal(r3.session, null, 'r3 应排队（A 忙）');

  const q = ops.listQueue(station.id).map((x) => x.requestId);
  assert.deepEqual(q, ['r2', 'r3'], '队列顺序应为 r2, r3');
});

test('停止后按提交先后补位，且容量参与判断', () => {
  const { station, spotA, spotB } = freshStation();
  ops.startRequest(station.id, { spotId: spotA.id, requestId: 'r1', powerKw: 60 });
  ops.startRequest(station.id, { spotId: spotA.id, requestId: 'r2', powerKw: 40 });
  ops.startRequest(station.id, { spotId: spotA.id, requestId: 'r3', powerKw: 20 });
  const s1 = ops.listSessions(station.id, 'active').find((s) => s.spotId === spotA.id);
  ops.stopRequest(station.id, { spotId: spotA.id, reportId: 'stop-r1', sessionId: s1.id });

  let active = ops.listSessions(station.id, 'active');
  const r2s = active.find((s) => s.spotId === spotA.id);
  assert.ok(r2s && r2s.powerKw === 40, 'r2 应补位开始');
  assert.equal(ops.listQueue(station.id).some((x) => x.requestId === 'r3'), true, 'r3 仍在排队');

  // B 位：r4(90) 因容量不足排队（当前 A=40，40+90>100）
  const r4 = ops.startRequest(station.id, { spotId: spotB.id, requestId: 'r4', powerKw: 90 });
  assert.equal(r4.session, null, 'r4 应因容量排队');

  // 停 r2 -> 补 r3(A,20)；此时负载 20，r4(B,90) 20+90>100 仍排队
  ops.stopRequest(station.id, { spotId: spotA.id, reportId: 'stop-r2', sessionId: r2s.id });
  active = ops.listSessions(station.id, 'active');
  const r3s = active.find((s) => s.spotId === spotA.id);
  assert.ok(r3s && r3s.powerKw === 20, 'r3 应补到 A');
  assert.equal(ops.listQueue(station.id).some((x) => x.requestId === 'r4'), true, 'r4 仍因容量排队');

  // 停 r3 -> 容量释放，补 r4(B,90)
  ops.stopRequest(station.id, { spotId: spotA.id, reportId: 'stop-r3', sessionId: r3s.id });
  active = ops.listSessions(station.id, 'active');
  assert.ok(active.some((s) => s.spotId === spotB.id && s.powerKw === 90), 'r4 应补到 B');
  assert.equal(ops.listQueue(station.id).length, 0, '队列应清空');

  // 任一时刻每个位至多一个 active
  const spotLoad = {};
  for (const s of active) spotLoad[s.spotId] = (spotLoad[s.spotId] || 0) + 1;
  assert.ok(Object.values(spotLoad).every((c) => c === 1), '每个位至多一个会话');
});

console.log('\n[2] 断网留住会话 + 重复上报幂等（不重复计费）');

test('重复启动/停止上报只算一次', () => {
  const { station, spotC } = freshStation();
  const a = ops.startRequest(station.id, { spotId: spotC.id, requestId: 'dup-start', powerKw: 30 });
  const b = ops.startRequest(station.id, { spotId: spotC.id, requestId: 'dup-start', powerKw: 30 });
  assert.equal(b.idempotent, true, '重复启动应幂等');
  assert.equal(b.session.id, a.session.id, '应返回同一会话');
  assert.equal(ops.listSessions(station.id).filter((s) => s.code === a.session.code).length, 1, '只有一个会话');

  const stop1 = ops.stopRequest(station.id, { spotId: spotC.id, reportId: 'dup-stop', sessionId: a.session.id });
  const stop2 = ops.stopRequest(station.id, { spotId: spotC.id, reportId: 'dup-stop', sessionId: a.session.id });
  assert.equal(stop2.idempotent, true, '重复停止应幂等');
  assert.equal(stop2.bill.id, stop1.bill.id, '应返回同一账单');
  assert.equal(ops.listBills(station.id).filter((b) => b.sessionId === a.session.id).length, 1, '只有一张账单');
});

test('断网期间会话不丢，恢复后接着计费', () => {
  const { station, spotC } = freshStation();
  const a = ops.startRequest(station.id, { spotId: spotC.id, requestId: 'offline-1', powerKw: 40 });
  const sid = a.session.id;
  // 断网
  ops.setOnline(station.id, false);
  assert.equal(ops.getStation(station.id).online, 0);
  // 断网期间会话仍在库里（留住未结算会话）
  let s = ops.listSessions(station.id, 'active').find((x) => x.id === sid);
  assert.ok(s, '断网期间会话应保留');
  // 恢复联网
  ops.setOnline(station.id, true);
  s = ops.listSessions(station.id, 'active').find((x) => x.id === sid);
  assert.ok(s && s.status === 'active', '恢复后会话仍在，可继续计费');
  // 恢复后停止，正常出账
  now = T0 + 3600000;
  const stopped = ops.stopRequest(station.id, { spotId: spotC.id, reportId: 'offline-stop', sessionId: sid });
  assert.equal(stopped.session.status, 'settled');
  assert.ok(stopped.bill.amount > 0, '恢复后应正常计费出账');
});

console.log('\n[3] 电价时段：未结算马上重算，已出账冻结');

test('分时电价计算正确（尖/峰/平/谷）', () => {
  const { station, spotC } = freshStation();
  // 低谷 00-08 0.5 元/度；平段 08-20 1.0；尖峰 20-24 2.0
  ops.setPriceSchedule(
    station.id,
    [
      { name: '低谷', start_minute: 0, end_minute: 8 * 60, rate: 0.5 },
      { name: '平段', start_minute: 8 * 60, end_minute: 20 * 60, rate: 1.0 },
      { name: '尖峰', start_minute: 20 * 60, end_minute: 24 * 60, rate: 2.0 },
    ],
    T0,
    'TOU'
  );
  // 07:00 开始，10kW，充到 09:00 -> 低谷1h(5) + 平段1h(10) = 15
  const start = Date.UTC(2026, 9, 5, 7, 0, 0);
  now = start;
  const r = ops.startRequest(station.id, { spotId: spotC.id, requestId: 'tou-1', powerKw: 10 });
  now = start + 2 * 3600000;
  const stopped = ops.stopRequest(station.id, { spotId: spotC.id, reportId: 'tou-stop', sessionId: r.session.id });
  assert.equal(stopped.bill.amount, 15, '07-09 跨低谷/平段应为 15 元');
});

test('电价一变，未结算会话费用立即重算；已出账账单不变', () => {
  const { station, spotC } = freshStation();
  // 全日 1.0
  ops.setPriceSchedule(
    station.id,
    [{ name: '平段', start_minute: 0, end_minute: 1440, rate: 1.0 }],
    T0,
    '全日1.0'
  );
  const start = T0; // 19:30
  now = start;
  const r = ops.startRequest(station.id, { spotId: spotC.id, requestId: 'recalc-1', powerKw: 10 });
  now = start + 3600000; // 1h
  let s = ops.listSessions(station.id, 'active').find((x) => x.id === r.session.id);
  assert.equal(s.amount, 10, '1h × 10kW × 1.0 = 10');

  // 电价涨 2.0（即刻生效）-> 未结算会话立即重算为 20
  ops.setPriceSchedule(
    station.id,
    [{ name: '平段', start_minute: 0, end_minute: 1440, rate: 2.0 }],
    now,
    '涨价'
  );
  s = ops.listSessions(station.id, 'active').find((x) => x.id === r.session.id);
  assert.equal(s.amount, 20, '涨价后未结算会话应立即重算为 20');

  // 出账 -> 账单冻结为 20
  const stopped = ops.stopRequest(station.id, { spotId: spotC.id, reportId: 'recalc-stop', sessionId: r.session.id });
  assert.equal(stopped.bill.amount, 20, '出账金额 20');

  // 再涨价 3.0，已出账账单保持 20 不变
  ops.setPriceSchedule(
    station.id,
    [{ name: '平段', start_minute: 0, end_minute: 1440, rate: 3.0 }],
    now,
    '再涨价'
  );
  const bills = ops.listBills(station.id).filter((b) => b.sessionId === r.session.id);
  assert.equal(bills[0].amount, 20, '已出账账单应冻结为 20，不受后续调价影响');
});

console.log('\n[4] 月度对账：少收 / 多收 / 平账 分列');

test('与支付渠道流水比对，差异会话单独列出', () => {
  const { station, spotC } = freshStation();
  // 造应收均为 10 的账单（10kW × 1h × 1.0）
  ops.setPriceSchedule(
    station.id,
    [{ name: '平段', start_minute: 0, end_minute: 1440, rate: 1.0 }],
    T0,
    '全日1.0'
  );
  const mk = (rid) => {
    now = T0;
    const r = ops.startRequest(station.id, { spotId: spotC.id, requestId: rid, powerKw: 10 });
    now = T0 + 3600000;
    return ops.stopRequest(station.id, { spotId: spotC.id, reportId: rid + '-stop', sessionId: r.session.id });
  };
  const a = mk('bill-a'); // 渠道 10 -> 平账
  const b = mk('bill-b'); // 渠道 8  -> 少收 2
  const c = mk('bill-c'); // 渠道 12 -> 多收 2
  assert.equal(a.bill.amount, 10);

  const recon = ops.reconcile(station.id, '2026-10', [
    { sessionCode: a.session.code, channelAmount: 10, paidAt: T0 + 3600000 },
    { sessionCode: b.session.code, channelAmount: 8, paidAt: T0 + 3600000 },
    { sessionCode: c.session.code, channelAmount: 12, paidAt: T0 + 3600000 },
    { sessionCode: 'NOPE', channelAmount: 5 }, // 渠道有、本站无账单
  ]);

  assert.equal(recon.summary.matched, 1);
  assert.equal(recon.summary.undercharged, 1, '少收 1 笔');
  assert.equal(recon.summary.overcharged, 1, '多收 1 笔');
  assert.equal(recon.summary.missingBill, 1, '渠道有流水但无账单 1 笔');
  assert.equal(recon.undercharged[0].sessionCode, b.session.code);
  assert.equal(recon.undercharged[0].difference, -2, '少收差额 -2');
  assert.equal(recon.overcharged[0].sessionCode, c.session.code);
  assert.equal(recon.overcharged[0].difference, 2, '多收差额 +2');

  // 本站有账单、渠道未结算
  const d = mk('bill-d');
  const recon2 = ops.reconcile(station.id, '2026-10', [
    { sessionCode: a.session.code, channelAmount: 10 },
    { sessionCode: b.session.code, channelAmount: 8 },
    { sessionCode: c.session.code, channelAmount: 12 },
  ]);
  assert.equal(recon2.summary.missingChannel, 1, '渠道漏结算 1 笔');
  assert.equal(recon2.missingChannel[0].sessionCode, d.session.code);
});

console.log('\n全部场景通过 ✅\n');
