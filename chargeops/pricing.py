"""分时电价与费用计算。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from decimal import Decimal, ROUND_HALF_UP

CENT = Decimal("0.01")


@dataclass(frozen=True)
class PriceSegment:
    """从当日 start 时刻起生效的电价（元/kWh），到下一时段开始前为止。"""

    start: time
    price: Decimal


class PriceSchedule:
    """一日内的分时电价表，按日循环。时段起点不可重复。"""

    def __init__(self, segments: list[PriceSegment]):
        if not segments:
            raise ValueError("at least one price segment is required")
        ordered = sorted(segments, key=lambda s: s.start)
        if len({s.start for s in ordered}) != len(ordered):
            raise ValueError("duplicate segment start times")
        self._segments = tuple(ordered)

    @property
    def segments(self) -> tuple[PriceSegment, ...]:
        return self._segments

    def price_at(self, at: datetime) -> Decimal:
        """at 时刻适用的电价：最后一个 start <= at 的时段，否则回绕到当日末段。"""
        tod = at.time()
        chosen = self._segments[-1]
        for seg in self._segments:
            if seg.start <= tod:
                chosen = seg
            else:
                break
        return chosen.price

    def fee_for(self, start: datetime, end: datetime, kwh: Decimal) -> Decimal:
        """[start, end) 内充入 kwh 的费用（未舍入）。

        假设区间内功率恒定，按各时段覆盖的时长比例分摊电量，再分别计价。
        跨时段边界、跨午夜都会正确切分。
        """
        if end < start:
            raise ValueError("end must not be earlier than start")
        if kwh < 0:
            raise ValueError("kwh must not be negative")
        if end == start or kwh == 0:
            return Decimal("0")
        total_seconds = Decimal(str((end - start).total_seconds()))
        fee = Decimal("0")
        cursor = start
        while cursor < end:
            nxt = min(end, self._next_boundary(cursor))
            share = Decimal(str((nxt - cursor).total_seconds())) / total_seconds
            fee += kwh * share * self.price_at(cursor)
            cursor = nxt
        return fee

    def _next_boundary(self, at: datetime) -> datetime:
        """at 之后最近的时段边界（含午夜）。"""
        midnight = datetime.combine(at.date() + timedelta(days=1), time.min)
        candidates = [midnight]
        for seg in self._segments:
            boundary = datetime.combine(at.date(), seg.start)
            if boundary > at:
                candidates.append(boundary)
        return min(candidates)


def quantize_fee(amount: Decimal) -> Decimal:
    return amount.quantize(CENT, rounding=ROUND_HALF_UP)
