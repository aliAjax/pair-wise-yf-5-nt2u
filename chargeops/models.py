"""领域模型：会话、电表读数、账单、渠道流水。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from enum import Enum, auto


class SessionState(Enum):
    QUEUED = auto()      # 已提交，排队等位或等容量
    CHARGING = auto()    # 占用充电位，计费中
    SETTLED = auto()     # 已出账，金额冻结


@dataclass
class MeterReading:
    """一次电表上报：累计电量（kWh）。"""

    at: datetime
    kwh_total: Decimal


@dataclass
class Session:
    """计费会话。QUEUED -> CHARGING -> SETTLED，不可逆。"""

    id: str
    pile_id: str
    user_id: str
    power_kw: Decimal
    state: SessionState
    submitted_at: datetime
    started_at: datetime | None = None
    settled_at: datetime | None = None
    readings: list[MeterReading] = field(default_factory=list)
    fee: Decimal = Decimal("0.00")

    @property
    def energy_kwh(self) -> Decimal:
        """会话累计充电量 = 末次读数 - 首次读数。"""
        if len(self.readings) < 2:
            return Decimal("0")
        return self.readings[-1].kwh_total - self.readings[0].kwh_total


@dataclass(frozen=True)
class Bill:
    """已出账账单。金额在结算时固化，之后电价调整不影响。"""

    id: str
    session_id: str
    pile_id: str
    user_id: str
    energy_kwh: Decimal
    amount: Decimal
    settled_at: datetime

    @property
    def month(self) -> str:
        """出账月份，格式 YYYY-MM，对账按此归集。"""
        return self.settled_at.strftime("%Y-%m")


@dataclass(frozen=True)
class PaymentRecord:
    """支付渠道流水，按 session_id 与账单勾稽。"""

    session_id: str
    paid: Decimal
    channel_ref: str = ""
