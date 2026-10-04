"""月度对账：站内账单 vs 支付渠道流水。"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from .models import Bill, PaymentRecord


@dataclass(frozen=True)
class Discrepancy:
    """一条账实不符记录。diff = 实收 - 应收。"""

    session_id: str
    billed: Decimal
    paid: Decimal

    @property
    def diff(self) -> Decimal:
        return self.paid - self.billed


@dataclass
class ReconReport:
    """对账结果：平账、少收（实收 < 应收）、多收（实收 > 应收）。"""

    month: str
    matched: list[str] = field(default_factory=list)
    under_collected: list[Discrepancy] = field(default_factory=list)
    over_collected: list[Discrepancy] = field(default_factory=list)
    total_billed: Decimal = Decimal("0")
    total_paid: Decimal = Decimal("0")

    @property
    def is_balanced(self) -> bool:
        return not self.under_collected and not self.over_collected


def reconcile(month: str, bills: list[Bill], payments: list[PaymentRecord]) -> ReconReport:
    """把当月账单与渠道流水按会话勾稽。

    - 同一会话的多笔流水先汇总再比对；
    - 有账单无流水（或流水不足）→ 少收；
    - 有流水无账单（或流水超出）→ 多收。
    """
    billed_by_session: dict[str, Decimal] = {}
    for bill in bills:
        if bill.month == month:
            billed_by_session[bill.session_id] = (
                billed_by_session.get(bill.session_id, Decimal("0")) + bill.amount
            )

    paid_by_session: dict[str, Decimal] = {}
    for record in payments:
        paid_by_session[record.session_id] = (
            paid_by_session.get(record.session_id, Decimal("0")) + record.paid
        )

    report = ReconReport(
        month=month,
        total_billed=sum(billed_by_session.values(), Decimal("0")),
        total_paid=sum(paid_by_session.values(), Decimal("0")),
    )
    for session_id in sorted(billed_by_session | paid_by_session.keys()):
        billed = billed_by_session.get(session_id, Decimal("0"))
        paid = paid_by_session.get(session_id, Decimal("0"))
        if paid < billed:
            report.under_collected.append(Discrepancy(session_id, billed, paid))
        elif paid > billed:
            report.over_collected.append(Discrepancy(session_id, billed, paid))
        else:
            report.matched.append(session_id)
    return report
