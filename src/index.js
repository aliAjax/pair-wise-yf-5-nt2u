const path = require('path');
const express = require('express');
const { initDb } = require('./db');
const { ChargingOps } = require('./domain');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = initDb();
const ops = new ChargingOps(db);

const wrap = (fn) => (req, res, next) => {
  try {
    res.json(fn(req));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// ---------- 站点 ----------
app.get('/api/stations', wrap(() => ops.listStations()));
app.post(
  '/api/stations',
  wrap((req) => {
    const { code, name, transformerCapacityKw } = req.body;
    return ops.createStation(code, name, transformerCapacityKw);
  })
);
app.get('/api/stations/:id', wrap((req) => ops.getStation(Number(req.params.id))));
app.patch(
  '/api/stations/:id/online',
  wrap((req) => ops.setOnline(Number(req.params.id), req.body.online))
);

// ---------- 充电位 ----------
app.get('/api/stations/:id/spots', wrap((req) => ops.listSpots(Number(req.params.id))));
app.post(
  '/api/stations/:id/spots',
  wrap((req) => ops.addSpot(Number(req.params.id), req.body.code))
);

// ---------- 启动 / 停止 ----------
app.post(
  '/api/stations/:id/start',
  wrap((req) => ops.startRequest(Number(req.params.id), req.body))
);
app.post(
  '/api/stations/:id/stop',
  wrap((req) => ops.stopRequest(Number(req.params.id), req.body))
);

// ---------- 会话 / 队列 / 账单 ----------
app.get(
  '/api/stations/:id/sessions',
  wrap((req) => ops.listSessions(Number(req.params.id), req.query.status))
);
app.get('/api/stations/:id/queue', wrap((req) => ops.listQueue(Number(req.params.id))));
app.get('/api/stations/:id/bills', wrap((req) => ops.listBills(Number(req.params.id))));

// ---------- 电价 ----------
app.get('/api/stations/:id/prices', wrap((req) => ops.listSchedules(Number(req.params.id))));
app.post(
  '/api/stations/:id/prices',
  wrap((req) => {
    const { periods, effectiveAt, note } = req.body;
    return ops.setPriceSchedule(Number(req.params.id), periods, effectiveAt, note);
  })
);

// ---------- 月度对账 ----------
app.post(
  '/api/stations/:id/reconciliation',
  wrap((req) => ops.reconcile(Number(req.params.id), req.body.period, req.body.entries || []))
);
app.get(
  '/api/stations/:id/reconciliation/:period',
  wrap((req) => ops.getReconciliation(Number(req.params.id), req.params.period))
);

// ---------- 概览（仪表盘用） ----------
app.get(
  '/api/stations/:id/overview',
  wrap((req) => {
    const id = Number(req.params.id);
    const station = ops.getStation(id);
    const spots = ops.listSpots(id);
    const active = ops.listSessions(id, 'active');
    const queue = ops.listQueue(id);
    const bills = ops.listBills(id);
    const load = active.reduce((s, x) => s + x.powerKw, 0);
    return {
      station,
      spots,
      activeSessions: active,
      queue,
      bills,
      loadKw: load,
      utilization: station.transformerCapacityKw ? load / station.transformerCapacityKw : 0,
    };
  })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`充电运营台 listening on http://localhost:${PORT}`);
});

module.exports = { app, ops };
