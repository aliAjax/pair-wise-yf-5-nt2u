"""端到端演示：排队补位 → 断网续算 → 电价重算 → 月度对账。

运行：python3 demo.py
"""

from datetime import datetime, time
from decimal import Decimal

from chargeops import ChargingStation, PaymentRecord, PriceSchedule, PriceSegment

# 峰谷电价：0-12 点 1 元/度，12-24 点 2 元/度
schedule = PriceSchedule([
    PriceSegment(time(0, 0), Decimal("1.0")),
    PriceSegment(time(12, 0), Decimal("2.0")),
])
# 变压器容量 120 kW
station = ChargingStation("ST-001", Decimal("120"), schedule)

t0 = datetime(2026, 10, 1, 18, 0)  # 晚高峰

print("== 1. 同一充电位同时来两个请求，先提交先充 ==")
s1 = station.submit_start("req-1", "P1", "车A", Decimal("60"), t0)
s2 = station.submit_start("req-2", "P1", "车B", Decimal("60"), t0)
print(f"  车A: {station.get_session(s1).state.name}, 车B: {station.get_session(s2).state.name}")

print("== 2. 容量到顶，第三台排队 ==")
s3 = station.submit_start("req-3", "P2", "车C", Decimal("60"), t0)
s4 = station.submit_start("req-4", "P3", "车D", Decimal("60"), t0)
print(f"  已用容量: {station.used_capacity_kw} kW, 车D: {station.get_session(s4).state.name}")

print("== 3. 车A 充电中断网，恢复后重放上报不双算 ==")
station.ingest_report("m1", s1, t0, Decimal("0"))
station.ingest_report("m2", s1, datetime(2026, 10, 1, 18, 30), Decimal("30"))
station.set_online(False)
print(f"  断网期间留住未结算会话: {[s.id for s in station.held_sessions]}")
station.set_online(True)
station.ingest_report("m1", s1, t0, Decimal("0"))           # 重放
station.ingest_report("m2", s1, datetime(2026, 10, 1, 18, 30), Decimal("30"))  # 重放
station.ingest_report("m3", s1, datetime(2026, 10, 1, 19, 0), Decimal("60"))   # 新上报
sess = station.get_session(s1)
print(f"  恢复后: 电量 {sess.energy_kwh} 度, 费用 {sess.fee} 元")

print("== 4. 车A 出账后电价调整：账单冻结，未结算的重算 ==")
bill_a = station.stop_session(s1, datetime(2026, 10, 1, 19, 0))
station.ingest_report("m4", s3, t0, Decimal("0"))
station.ingest_report("m5", s3, datetime(2026, 10, 1, 19, 0), Decimal("60"))
print(f"  车A 账单: {bill_a.amount} 元")
station.update_price_schedule(PriceSchedule([PriceSegment(time(0, 0), Decimal("3.0"))]))
print(f"  涨价后 车C 未结算费用: {station.get_session(s3).fee} 元, 车A 账单仍 {bill_a.amount} 元")

print("== 5. 补位与月度对账 ==")
print(f"  车A 离场后 车B: {station.get_session(s2).state.name}")
bill_c = station.stop_session(s3, datetime(2026, 10, 1, 19, 30))
print(f"  车C 离场后 车D: {station.get_session(s4).state.name}")

payments = [
    PaymentRecord(s1, bill_a.amount),                 # 平账
    PaymentRecord(s3, bill_c.amount - Decimal("5")),  # 少收 5 元
    PaymentRecord("S-UNKNOWN", Decimal("9.9")),       # 无账单，多收
]
report = station.reconcile("2026-10", payments)
print(f"  平账: {report.matched}")
print(f"  少收: {[(d.session_id, str(-d.diff)) for d in report.under_collected]}")
print(f"  多收: {[(d.session_id, str(d.diff)) for d in report.over_collected]}")
