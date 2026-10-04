const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;

function initDb(dbPath) {
  if (db) return db;
  const file = dbPath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'charging.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

function getDb() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  transformer_capacity_kw REAL NOT NULL,
  online INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL,
  UNIQUE(station_id, code)
);

CREATE TABLE IF NOT EXISTS queue_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL,
  spot_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  car_code TEXT,
  power_kw REAL NOT NULL,
  status TEXT NOT NULL,               -- waiting | active | cancelled
  submitted_at INTEGER NOT NULL,
  promoted_at INTEGER,
  session_id INTEGER,
  UNIQUE(station_id, request_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL,
  spot_id INTEGER NOT NULL,
  queue_entry_id INTEGER,
  code TEXT NOT NULL,
  status TEXT NOT NULL,               -- active | settled
  power_kw REAL NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  energy_kwh REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  bill_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  energy_kwh REAL NOT NULL,
  amount REAL NOT NULL,
  issued_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued'
);

CREATE TABLE IF NOT EXISTS price_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL,
  effective_at INTEGER NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS price_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  start_minute INTEGER NOT NULL,
  end_minute INTEGER NOT NULL,
  rate REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(station_id, event_id)
);

CREATE TABLE IF NOT EXISTS reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  UNIQUE(station_id, period)
);

CREATE TABLE IF NOT EXISTS reconciliation_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_id INTEGER NOT NULL,
  session_code TEXT NOT NULL,
  session_id INTEGER,
  bill_amount REAL,
  channel_amount REAL NOT NULL,
  paid_at INTEGER,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spots_station ON spots(station_id);
CREATE INDEX IF NOT EXISTS idx_queue_station_status ON queue_entries(station_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_station_status ON sessions(station_id, status);
CREATE INDEX IF NOT EXISTS idx_bills_station ON bills(station_id);
CREATE INDEX IF NOT EXISTS idx_schedules_station ON price_schedules(station_id, effective_at);
`;

module.exports = { initDb, getDb };
