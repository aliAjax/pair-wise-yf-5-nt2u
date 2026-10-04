// 充电运营台核心领域逻辑
// 关键不变量：
//  1) 一个充电位同一时刻至多一个 active 计费会话；
//  2) 变压器容量约束下，等待队列按提交时间先后（全局 FIFO）补位；
//  3) 所有上报/启动请求带幂等键，重复上报不产生第二次计费；
//  4) 电价变更只重算「未结算(active)」会话，已出账账单冻结；
//  5) 每月与支付渠道对账，少收/多收分列。

const { computeFee, defaultPeriods } = require('./pricing');

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const pad = (n) => String(n).padStart(4, '0');

class ChargingOps {
  constructor(db, clock) {
    this.db = db;
    // 可注入时钟：默认走真实时间，测试可拨到任意时刻验证费用/重算。
    this._clock = clock || null;
  }

  now() {
    return this._clock ? this._clock() : Date.now();
  }

  // ---------- 事务封装 ----------
  tx(fn) {
    return this.db.transaction(fn)();
  }

  // ---------- 站点 / 充电位 ----------
  createStation(code, name, transformerCapacityKw) {
    return this.tx(() => {
      const now = this.now();
      const info = this.db
        .prepare('INSERT INTO stations (code, name, transformer_capacity_kw, online, created_at) VALUES (?, ?, ?, 1, ?)')
        .run(code, name, transformerCapacityKw, now);
      // 默认分时电价
      this._insertSchedule(info.lastInsertRowid, defaultPeriods(), now, '默认时段');
      return this.getStation(info.lastInsertRowid);
    });
  }

  getStation(stationId) {
    const s = this.db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!s) throw new Error('站点不存在');
    return s;
  }

  getStationByCode(code) {
    return this.db.prepare('SELECT * FROM stations WHERE code = ?').get(code);
  }

  listStations() {
    return this.db.prepare('SELECT * FROM stations ORDER BY id').all();
  }

  setOnline(stationId, online) {
    this.getStation(stationId);
    this.db.prepare('UPDATE stations SET online = ? WHERE id = ?').run(online ? 1 : 0, stationId);
    return this.getStation(stationId);
  }

  addSpot(stationId, code) {
    this.getStation(stationId);
    const now = this.now();
    const info = this.db
      .prepare('INSERT INTO spots (station_id, code, status, created_at) VALUES (?, ?, ?, ?)')
      .run(stationId, code, 'free', now);
    return this.db.prepare('SELECT * FROM spots WHERE id = ?').get(info.lastInsertRowid);
  }

  listSpots(stationId) {
    this.getStation(stationId);
    return this.db
      .prepare(
        `SELECT s.*,
                (SELECT q.id FROM queue_entries q WHERE q.spot_id = s.id AND q.status = 'waiting' ORDER BY q.submitted_at LIMIT 1) AS next_queue_id,
                (SELECT COUNT(*) FROM queue_entries q WHERE q.spot_id = s.id AND q.status = 'waiting') AS waiting_count
         FROM spots s WHERE s.station_id = ? ORDER BY s.id`
      )
      .all(stationId);
  }

  // ---------- 电价 ----------
  _insertSchedule(stationId, periods, effectiveAt, note) {
    const now = this.now();
    const info = this.db
      .prepare('INSERT INTO price_schedules (station_id, effective_at, note, created_at) VALUES (?, ?, ?, ?)')
      .run(stationId, effectiveAt, note || null, now);
    const scheduleId = info.lastInsertRowid;
    const stmt = this.db.prepare(
      'INSERT INTO price_periods (schedule_id, name, start_minute, end_minute, rate) VALUES (?, ?, ?, ?, ?)'
    );
    for (const p of periods) {
      stmt.run(scheduleId, p.name, p.start_minute, p.end_minute, p.rate);
    }
    return scheduleId;
  }

  // 取某时刻生效的时段表（effective_at <= atMs 的最新一份）
  getPeriodsAt(stationId, atMs) {
    const sched = this.db
      .prepare('SELECT * FROM price_schedules WHERE station_id = ? AND effective_at <= ? ORDER BY effective_at DESC, id DESC LIMIT 1')
      .get(stationId, atMs);
    if (!sched) return defaultPeriods();
    return this.db.prepare('SELECT name, start_minute, end_minute, rate FROM price_periods WHERE schedule_id = ? ORDER BY id').all(sched.id);
  }

  listSchedules(stationId) {
    const schedules = this.db
      .prepare('SELECT * FROM price_schedules WHERE station_id = ? ORDER BY effective_at DESC, id DESC')
      .all(stationId);
    const stmt = this.db.prepare('SELECT name, start_minute, end_minute, rate FROM price_periods WHERE schedule_id = ? ORDER BY id');
    return schedules.map((s) => ({ ...s, periods: stmt.all(s.id) }));
  }

  // 电价变更：立即重算所有未结算会话；已出账账单不动。
  setPriceSchedule(stationId, periods, effectiveAt, note) {
    return this.tx(() => {
      this.getStation(stationId);
      const eff = effectiveAt || this.now();
      this._insertSchedule(stationId, periods, eff, note || '电价调整');
      const recalculated = this._recalcUnsettled(stationId, eff);
      return { effectiveAt: eff, recalculated };
    });
  }

  // 重算未结算(active)会话费用，截止 asOf。返回重算的会话数。
  _recalcUnsettled(stationId, asOf) {
    const periods = this.getPeriodsAt(stationId, asOf);
    const actives = this.db
      .prepare('SELECT * FROM sessions WHERE station_id = ? AND status = ? ORDER BY id')
      .all(stationId, 'active');
    const upd = this.db.prepare(
      'UPDATE sessions SET energy_kwh = ?, amount = ?, updated_at = ? WHERE id = ?'
    );
    for (const s of actives) {
      const { energyKwh, amount } = computeFee(s.power_kw, s.start_at, asOf, periods);
      upd.run(round4(energyKwh), round2(amount), asOf, s.id);
    }
    return actives.length;
  }

  // ---------- 变压器负载 / 排队补位 ----------
  _activeLoad(stationId) {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(power_kw), 0) AS kw FROM sessions WHERE station_id = ? AND status = ?')
      .get(stationId, 'active');
    return row.kw;
  }

  // 补位循环：只要有「目标位空闲 + 容量允许」的等待记录，就按提交先后补位。
  _promote(stationId) {
    const station = this.getStation(stationId);
    const promoted = [];
    while (true) {
      const load = this._activeLoad(stationId);
      const next = this.db
        .prepare(
          `SELECT q.* FROM queue_entries q
           JOIN spots s ON s.id = q.spot_id
           WHERE q.station_id = ? AND q.status = 'waiting'
             AND s.status = 'free'
             AND ? + q.power_kw <= ?
           ORDER BY q.submitted_at ASC, q.id ASC
           LIMIT 1`
        )
        .get(stationId, load, station.transformer_capacity_kw);
      if (!next) break;

      const now = this.now();
      const seq = this._nextSeq(stationId, 'session');
      const code = `${station.code}S${pad(seq)}`;
      const sInfo = this.db
        .prepare(
          `INSERT INTO sessions (station_id, spot_id, queue_entry_id, code, status, power_kw, start_at, energy_kwh, amount, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, 0, 0, ?, ?)`
        )
        .run(stationId, next.spot_id, next.id, code, next.power_kw, now, now, now);
      const sessionId = sInfo.lastInsertRowid;

      this.db
        .prepare("UPDATE queue_entries SET status = 'active', promoted_at = ?, session_id = ? WHERE id = ?")
        .run(now, sessionId, next.id);
      this.db.prepare("UPDATE spots SET status = 'busy' WHERE id = ?").run(next.spot_id);

      promoted.push({ queueEntryId: next.id, sessionId, code, spotId: next.spot_id, startAt: now });
    }
    return promoted;
  }

  _nextSeq(stationId, kind) {
    const table = kind === 'session' ? 'sessions' : 'bills';
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE station_id = ?`).get(stationId);
    return row.c + 1;
  }

  // ---------- 启动请求（幂等 + 排队 + 补位） ----------
  startRequest(stationId, payload) {
    const { spotId, requestId, powerKw, carCode } = payload;
    if (!requestId) throw new Error('缺少 requestId（幂等键）');
    if (!powerKw || powerKw <= 0) throw new Error('powerKw 非法');
    return this.tx(() => {
      const cached = this.db
        .prepare('SELECT result FROM inbox WHERE station_id = ? AND event_id = ?')
        .get(stationId, requestId);
      if (cached) return { ...JSON.parse(cached.result), idempotent: true };

      this.getStation(stationId);
      const spot = this.db.prepare('SELECT * FROM spots WHERE id = ? AND station_id = ?').get(spotId, stationId);
      if (!spot) throw new Error('充电位不存在');

      const now = this.now();
      const qInfo = this.db
        .prepare(
          `INSERT INTO queue_entries (station_id, spot_id, request_id, car_code, power_kw, status, submitted_at)
           VALUES (?, ?, ?, ?, ?, 'waiting', ?)`
        )
        .run(stationId, spotId, requestId, carCode || null, powerKw, now);

      const promoted = this._promote(stationId);
      const entry = this.db.prepare('SELECT * FROM queue_entries WHERE id = ?').get(qInfo.lastInsertRowid);
      const session = entry.session_id
        ? this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(entry.session_id)
        : null;

      const result = {
        entry: this._publicQueueEntry(entry),
        session: session ? this._publicSession(session) : null,
        promotedNow: promoted.some((p) => p.queueEntryId === entry.id),
      };
      this.db
        .prepare('INSERT INTO inbox (station_id, event_id, kind, payload, result, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(stationId, requestId, 'start', JSON.stringify(payload), JSON.stringify(result), now);
      return result;
    });
  }

  // ---------- 停止/结算请求（幂等 + 出账 + 补位） ----------
  stopRequest(stationId, payload) {
    const { spotId, reportId, sessionId } = payload;
    if (!reportId) throw new Error('缺少 reportId（上报幂等键）');
    return this.tx(() => {
      const cached = this.db
        .prepare('SELECT result FROM inbox WHERE station_id = ? AND event_id = ?')
        .get(stationId, reportId);
      if (cached) return { ...JSON.parse(cached.result), idempotent: true };

      this.getStation(stationId);
      let session;
      if (sessionId) {
        session = this.db
          .prepare("SELECT * FROM sessions WHERE id = ? AND station_id = ? AND status = 'active'")
          .get(sessionId, stationId);
      } else {
        session = this.db
          .prepare("SELECT * FROM sessions WHERE station_id = ? AND spot_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
          .get(stationId, spotId);
      }
      if (!session) throw new Error('没有可结算的进行中会话');

      const now = this.now();
      const periods = this.getPeriodsAt(stationId, now);
      const { energyKwh, amount } = computeFee(session.power_kw, session.start_at, now, periods);
      const energy = round4(energyKwh);
      const fee = round2(amount);

      const seq = this._nextSeq(stationId, 'bill');
      const station = this.getStation(stationId);
      const billCode = `${station.code}B${pad(seq)}`;
      const bInfo = this.db
        .prepare(
          `INSERT INTO bills (station_id, session_id, code, energy_kwh, amount, issued_at, status)
           VALUES (?, ?, ?, ?, ?, ?, 'issued')`
        )
        .run(stationId, session.id, billCode, energy, fee, now);
      const bill = this.db.prepare('SELECT * FROM bills WHERE id = ?').get(bInfo.lastInsertRowid);

      this.db
        .prepare("UPDATE sessions SET status = 'settled', end_at = ?, energy_kwh = ?, amount = ?, bill_id = ?, updated_at = ? WHERE id = ?")
        .run(now, energy, fee, bill.id, now, session.id);
      this.db.prepare("UPDATE spots SET status = 'free' WHERE id = ?").run(session.spot_id);
      this.db
        .prepare("UPDATE queue_entries SET status = 'completed' WHERE session_id = ?")
        .run(session.id);

      // 容量释放后补位
      const promoted = this._promote(stationId);

      const fresh = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
      const result = {
        session: this._publicSession(fresh),
        bill: this._publicBill(bill),
        promotedNow: promoted,
      };
      this.db
        .prepare('INSERT INTO inbox (station_id, event_id, kind, payload, result, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(stationId, reportId, 'stop', JSON.stringify(payload), JSON.stringify(result), now);
      return result;
    });
  }

  // ---------- 查询 ----------
  listSessions(stationId, status) {
    this.getStation(stationId);
    let rows;
    if (status) {
      rows = this.db
        .prepare('SELECT * FROM sessions WHERE station_id = ? AND status = ? ORDER BY id DESC')
        .all(stationId, status);
    } else {
      rows = this.db.prepare('SELECT * FROM sessions WHERE station_id = ? ORDER BY id DESC').all(stationId);
    }
    // active(未结算)会话的预估费用按「当前时钟 + 最新电价」懒计算，
    // 这样既反映时长累积，也让「调价后立即重算」在读数时即刻生效；
    // settled(已出账)会话直接返回冻结值。
    const now = this.now();
    const periods = this.getPeriodsAt(stationId, now);
    return rows.map((r) => {
      const s = this._publicSession(r);
      if (s.status === 'active') {
        const { energyKwh, amount } = computeFee(s.powerKw, s.startAt, now, periods);
        s.energyKwh = round4(energyKwh);
        s.amount = round2(amount);
      }
      return s;
    });
  }

  listQueue(stationId) {
    this.getStation(stationId);
    return this.db
      .prepare(
        `SELECT q.*, s.code AS spot_code
         FROM queue_entries q JOIN spots s ON s.id = q.spot_id
         WHERE q.station_id = ? AND q.status = 'waiting'
         ORDER BY q.submitted_at, q.id`
      )
      .all(stationId)
      .map((q) => this._publicQueueEntry(q));
  }

  listBills(stationId) {
    this.getStation(stationId);
    return this.db
      .prepare('SELECT * FROM bills WHERE station_id = ? ORDER BY id DESC')
      .all(stationId)
      .map((b) => this._publicBill(b));
  }

  // ---------- 月度对账 ----------
  // entries: [{ sessionCode, channelAmount, paidAt }]
  reconcile(stationId, period, entries) {
    return this.tx(() => {
      this.getStation(stationId);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('period 格式应为 YYYY-MM');

      let rec = this.db
        .prepare('SELECT * FROM reconciliations WHERE station_id = ? AND period = ?')
        .get(stationId, period);
      if (!rec) {
        const now = this.now();
        const info = this.db
          .prepare('INSERT INTO reconciliations (station_id, period, status, created_at) VALUES (?, ?, ?, ?)')
          .run(stationId, period, 'draft', now);
        rec = this.db.prepare('SELECT * FROM reconciliations WHERE id = ?').get(info.lastInsertRowid);
      }
      // 重新上传则覆盖明细
      this.db.prepare('DELETE FROM reconciliation_entries WHERE reconciliation_id = ?').run(rec.id);

      const buckets = {
        matched: [],
        undercharged: [], // 少收：渠道实收 < 应收
        overcharged: [], // 多收：渠道实收 > 应收
        missingBill: [], // 渠道有流水但本站无账单
      };

      const findSession = this.db.prepare('SELECT * FROM sessions WHERE station_id = ? AND code = ?');
      const findBill = this.db.prepare('SELECT * FROM bills WHERE station_id = ? AND session_id = ?');
      const ins = this.db.prepare(
        `INSERT INTO reconciliation_entries
         (reconciliation_id, session_code, session_id, bill_amount, channel_amount, paid_at, result, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const channelSessionIds = new Set();
      const now = this.now();
      for (const e of entries) {
        const session = findSession.get(stationId, e.sessionCode);
        const bill = session ? findBill.get(stationId, session.id) : null;
        const billAmount = bill ? bill.amount : null;
        let result;
        if (!bill) result = 'missing_bill';
        else if (Math.round(e.channelAmount * 100) < Math.round(billAmount * 100)) result = 'undercharged';
        else if (Math.round(e.channelAmount * 100) > Math.round(billAmount * 100)) result = 'overcharged';
        else result = 'matched';

        if (session) channelSessionIds.add(session.id);
        ins.run(
          rec.id,
          e.sessionCode,
          session ? session.id : null,
          billAmount,
          e.channelAmount,
          e.paidAt || null,
          result,
          now
        );

        const row = {
          sessionCode: e.sessionCode,
          billAmount,
          channelAmount: e.channelAmount,
          difference: billAmount == null ? null : round2(e.channelAmount - billAmount),
        };
        if (result === 'matched') buckets.matched.push(row);
        else if (result === 'undercharged') buckets.undercharged.push(row);
        else if (result === 'overcharged') buckets.overcharged.push(row);
        else buckets.missingBill.push(row);
      }

      // 本站有账单但渠道流水缺失
      const missingChannel = this.db
        .prepare(
          `SELECT s.code AS sessionCode, b.amount AS billAmount
           FROM bills b JOIN sessions s ON s.id = b.session_id
           WHERE b.station_id = ? AND b.status = 'issued'
             AND b.session_id NOT IN (
               SELECT re.session_id FROM reconciliation_entries re
               WHERE re.reconciliation_id = ? AND re.session_id IS NOT NULL
             )`
        )
        .all(stationId, rec.id)
        .map((r) => ({ sessionCode: r.sessionCode, billAmount: r.billAmount, channelAmount: null, difference: null }));

      const summary = {
        period,
        matched: buckets.matched.length,
        undercharged: buckets.undercharged.length,
        overcharged: buckets.overcharged.length,
        missingBill: buckets.missingBill.length,
        missingChannel: missingChannel.length,
      };

      return {
        period,
        summary,
        undercharged: buckets.undercharged,
        overcharged: buckets.overcharged,
        missingBill: buckets.missingBill,
        missingChannel,
        matched: buckets.matched,
      };
    });
  }

  getReconciliation(stationId, period) {
    this.getStation(stationId);
    const rec = this.db
      .prepare('SELECT * FROM reconciliations WHERE station_id = ? AND period = ?')
      .get(stationId, period);
    if (!rec) return null;
    const entries = this.db
      .prepare('SELECT * FROM reconciliation_entries WHERE reconciliation_id = ? ORDER BY id')
      .all(rec.id);
    const groups = { matched: [], undercharged: [], overcharged: [], missing_bill: [] };
    for (const e of entries) {
      const row = {
        sessionCode: e.session_code,
        billAmount: e.bill_amount,
        channelAmount: e.channel_amount,
        difference: e.bill_amount == null ? null : round2(e.channel_amount - e.bill_amount),
      };
      (groups[e.result] || groups.matched).push(row);
    }
    return {
      period,
      finalized: !!rec.finalized_at,
      summary: {
        matched: groups.matched.length,
        undercharged: groups.undercharged.length,
        overcharged: groups.overcharged.length,
        missingBill: groups.missing_bill.length,
      },
      undercharged: groups.undercharged,
      overcharged: groups.overcharged,
      missingBill: groups.missing_bill,
      matched: groups.matched,
    };
  }

  // ---------- 序列化 ----------
  _publicQueueEntry(q) {
    return {
      id: q.id,
      stationId: q.station_id,
      spotId: q.spot_id,
      spotCode: q.spot_code,
      requestId: q.request_id,
      carCode: q.car_code,
      powerKw: q.power_kw,
      status: q.status,
      submittedAt: q.submitted_at,
      promotedAt: q.promoted_at,
      sessionId: q.session_id,
    };
  }

  _publicSession(s) {
    return {
      id: s.id,
      stationId: s.station_id,
      spotId: s.spot_id,
      code: s.code,
      status: s.status,
      powerKw: s.power_kw,
      startAt: s.start_at,
      endAt: s.end_at,
      energyKwh: s.energy_kwh,
      amount: s.amount,
      billId: s.bill_id,
    };
  }

  _publicBill(b) {
    return {
      id: b.id,
      stationId: b.station_id,
      sessionId: b.session_id,
      code: b.code,
      energyKwh: b.energy_kwh,
      amount: b.amount,
      issuedAt: b.issued_at,
      status: b.status,
    };
  }
}

module.exports = { ChargingOps };
