// 分时电价计费：把一个计费会话的时长按「尖/峰/平/谷」时段切分，
// 分别累加电量 × 单价。单价 = 元/度（元/kWh）。

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function minuteOfDay(ms) {
  // 用 UTC 取一天内的分钟数，避免时区漂移；电价时段按本地钟点语义定义。
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// 判断某个时刻落在哪个电价时段，返回该时段单价。
function rateAt(ms, periods) {
  const mod = minuteOfDay(ms);
  for (const p of periods) {
    const s = p.start_minute;
    const e = p.end_minute;
    const inRange = s < e ? mod >= s && mod < e : mod >= s || mod < e; // 跨午夜
    if (inRange) return p.rate;
  }
  // 兜底：未覆盖时段取第一个时段单价（调用方应保证时段覆盖全天）。
  return periods.length ? periods[0].rate : 1;
}

// 计算会话在 [startMs, endMs) 区间内的电量与电费。
// powerKw：充电功率（kW），视为恒定；实际场景可按曲线积分，这里按恒定功率。
function computeFee(powerKw, startMs, endMs, periods) {
  if (endMs <= startMs || !periods || periods.length === 0) {
    return { energyKwh: 0, amount: 0 };
  }
  // 收集区间内所有时段边界（含跨午夜时段的次日边界）。
  const boundaries = new Set([startMs, endMs]);
  const startDay = Math.floor(startMs / DAY_MS) * DAY_MS;
  const endDay = Math.floor(endMs / DAY_MS) * DAY_MS;
  for (let d = startDay; d <= endDay; d += DAY_MS) {
    for (const p of periods) {
      const sStart = d + p.start_minute * MINUTE_MS;
      if (p.start_minute < p.end_minute) {
        boundaries.add(sStart);
        boundaries.add(d + p.end_minute * MINUTE_MS);
      } else {
        // 跨午夜：如 23:00 -> 次日 07:00
        boundaries.add(sStart);
        boundaries.add(d + p.end_minute * MINUTE_MS + DAY_MS);
      }
    }
  }
  const pts = [...boundaries]
    .filter((t) => t >= startMs && t <= endMs)
    .sort((a, b) => a - b);

  let amount = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (b <= a) continue;
    const rate = rateAt((a + b) / 2, periods);
    amount += powerKw * ((b - a) / HOUR_MS) * rate;
  }
  const energyKwh = (powerKw * (endMs - startMs)) / HOUR_MS;
  return { energyKwh, amount };
}

// 默认分时时段（尖/峰/平/谷），元/度。
function defaultPeriods() {
  return [
    { name: '尖峰', start_minute: 19 * 60, end_minute: 21 * 60, rate: 1.4 },
    { name: '高峰', start_minute: 8 * 60, end_minute: 11 * 60, rate: 1.1 },
    { name: '平段', start_minute: 11 * 60, end_minute: 19 * 60, rate: 0.8 },
    { name: '低谷', start_minute: 23 * 60, end_minute: 7 * 60, rate: 0.4 },
  ];
}

module.exports = { computeFee, rateAt, defaultPeriods, MINUTE_MS, HOUR_MS, DAY_MS };
