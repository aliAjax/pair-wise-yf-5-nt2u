# 充电运营台（chargeops）

覆盖充电站晚高峰运营的四个核心问题：

| 场景 | 机制 |
| --- | --- |
| 两台车同时抢一个充电位 | 一桩一会话，其余按提交先后进 FIFO 队列，空位即补 |
| 变压器容量到顶 | 站级容量闸门：已分配功率 + 请求功率 > 容量则排队等容量 |
| 站控断网 | 未结算会话原样留住；恢复后接着计费；上报按 `report_id` 幂等去重，重放不双算 |
| 电价时段调整 | 未结算会话费用由电表读数历史 × 当前电价表实时推导，换表立即重算；已出账账单金额冻结 |
| 月度对账 | 账单与支付渠道流水按会话勾稽，少收 / 多收分别列出 |

## 结构

```
chargeops/
  pricing.py    分时电价表，跨时段/跨午夜切分计价
  models.py     会话、电表读数、账单、渠道流水
  station.py    站控核心：排队调度、容量闸门、幂等上报、结算出账
  reconcile.py  月度对账
tests/          unittest，20 个用例
demo.py         端到端演示
```

## 关键设计

- **幂等**：启动请求按 `request_id` 去重（重复提交返回原会话）；电表上报按
  `report_id` 去重（断网恢复后的重放直接丢弃）；结算重复调用返回原账单。
- **费用推导**：会话费用不落增量，而是由读数历史按当前电价表重算得出
  （`station.py:_compute_fee`），因此电价表一换，未结算会话费用立即正确；
  结算时把金额固化进 `Bill`，之后的电价调整不再影响。
- **计价切分**：`PriceSchedule.fee_for` 假设区间内功率恒定，按各时段覆盖
  时长比例分摊电量，跨时段边界和跨午夜都能正确计价。
- **补位顺序**：每个充电位一条 FIFO；容量不足时该队首留在队列里等容量，
  不阻塞其他充电位补位。

## 运行

```bash
python3 -m unittest discover -s tests   # 测试
python3 demo.py                          # 端到端演示
```

## 用法示例

```python
from datetime import datetime, time
from decimal import Decimal
from chargeops import ChargingStation, PaymentRecord, PriceSchedule, PriceSegment

schedule = PriceSchedule([
    PriceSegment(time(0, 0), Decimal("1.0")),    # 0-12 点 1 元/度
    PriceSegment(time(12, 0), Decimal("2.0")),   # 12-24 点 2 元/度
])
station = ChargingStation("ST-001", Decimal("120"), schedule)  # 容量 120 kW

t0 = datetime(2026, 10, 1, 18, 0)
s1 = station.submit_start("req-1", "P1", "车A", Decimal("60"), t0)
station.ingest_report("m1", s1, t0, Decimal("0"))
station.ingest_report("m2", s1, datetime(2026, 10, 1, 19, 0), Decimal("60"))

bill = station.stop_session(s1, datetime(2026, 10, 1, 19, 0))  # 120.00 元
report = station.reconcile("2026-10", [PaymentRecord(s1, bill.amount)])
assert report.is_balanced
```
