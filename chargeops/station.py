"""站控核心：排队调度、容量闸门、断网续算、幂等上报、结算出账。"""

from __future__ import annotations

from collections import deque
from datetime import datetime
from decimal import Decimal

from .models import Bill, MeterReading, PaymentRecord, Session, SessionState
from .pricing import PriceSchedule, quantize_fee
from .reconcile import ReconReport, reconcile


class ChargingStation:
    """一座充电站的运营台。

    - 一个充电位同一时刻只跑一个计费会话，其余请求按提交先后排队补位；
    - 全站已分配功率达到变压器容量后，新请求排队等容量；
    - 电表上报按 report_id 幂等去重，断网恢复后的重放不会重复计费；
    - 断网期间未结算会话原样保留，恢复后接着计费；
    - 电价表更新后，未结算会话费用立即按新表重算，已出账账单不动。
    """

    def __init__(self, station_id: str, capacity_kw: Decimal, price_schedule: PriceSchedule):
        if capacity_kw <= 0:
            raise ValueError("capacity_kw must be positive")
        self.station_id = station_id
        self.capacity_kw = capacity_kw
        self._price = price_schedule
        self.online = True

        self._sessions: dict[str, Session] = {}
        self._queues: dict[str, deque[str]] = {}       # pile_id -> 排队会话 id（FIFO）
        self._active_by_pile: dict[str, str] = {}      # pile_id -> 充电中会话 id
        self._request_index: dict[str, str] = {}       # request_id -> session_id（幂等）
        self._seen_reports: set[str] = set()           # 已处理的 report_id
        self._bills: list[Bill] = []
        self._bill_by_session: dict[str, Bill] = {}
        self._seq = 0

    # ---------- 启动请求与排队 ----------

    def submit_start(
        self,
        request_id: str,
        pile_id: str,
        user_id: str,
        power_kw: Decimal,
        at: datetime,
    ) -> str:
        """提交启动请求，返回会话 id。request_id 幂等：重复提交返回原会话。"""
        if request_id in self._request_index:
            return self._request_index[request_id]
        if power_kw <= 0:
            raise ValueError("power_kw must be positive")

        self._seq += 1
        session = Session(
            id=f"S{self._seq:04d}",
            pile_id=pile_id,
            user_id=user_id,
            power_kw=power_kw,
            state=SessionState.QUEUED,
            submitted_at=at,
        )
        self._sessions[session.id] = session
        self._request_index[request_id] = session.id
        self._queues.setdefault(pile_id, deque()).append(session.id)
        self._promote(at)
        return session.id

    def _promote(self, at: datetime) -> None:
        """按提交先后补位：充电位空闲且容量够，队首会话开工。

        逐轮扫描各充电位队首（全局按提交时间排序），容量不足的队首留在
        队列里等容量，不阻塞其他充电位的补位。
        """
        while True:
            promoted = False
            heads = (
                (self._sessions[q[0]], q)
                for p, q in self._queues.items()
                if q and p not in self._active_by_pile
            )
            for session, queue in sorted(heads, key=lambda h: h[0].submitted_at):
                if self.used_capacity_kw + session.power_kw > self.capacity_kw:
                    continue
                queue.popleft()
                session.state = SessionState.CHARGING
                session.started_at = at
                self._active_by_pile[session.pile_id] = session.id
                promoted = True
            if not promoted:
                return

    # ---------- 电表上报（幂等） ----------

    def ingest_report(
        self,
        report_id: str,
        session_id: str,
        at: datetime,
        kwh_total: Decimal,
    ) -> bool:
        """接收一次电表上报。重复上报（同 report_id）直接丢弃，返回 False。"""
        if report_id in self._seen_reports:
            return False
        if session_id not in self._sessions:
            raise ValueError(f"unknown session: {session_id}")
        session = self._sessions[session_id]
        if session.state is not SessionState.CHARGING:
            raise ValueError(f"session {session_id} is not charging")
        if session.readings and at < session.readings[-1].at:
            raise ValueError("report timestamp goes backwards")
        if session.readings and kwh_total < session.readings[-1].kwh_total:
            raise ValueError("meter reading goes backwards")

        self._seen_reports.add(report_id)
        session.readings.append(MeterReading(at=at, kwh_total=kwh_total))
        session.fee = self._compute_fee(session)
        return True

    # ---------- 断网 / 恢复 ----------

    def set_online(self, online: bool) -> None:
        """切换站控链路状态。断网不会动任何未结算会话。"""
        self.online = online

    @property
    def held_sessions(self) -> list[Session]:
        """断网期间被留住的未结算会话（充电中 + 排队中）。"""
        return [
            s
            for s in self._sessions.values()
            if s.state is not SessionState.SETTLED
        ]

    # ---------- 结算 ----------

    def stop_session(self, session_id: str, at: datetime) -> Bill:
        """结束充电并出账。幂等：已结算的会话重复调用返回原账单。"""
        session = self._require_session(session_id)
        if session.state is SessionState.SETTLED:
            return self._bill_by_session[session_id]
        if session.state is SessionState.QUEUED:
            self._remove_from_queue(session)
            session.state = SessionState.SETTLED
            session.settled_at = at
            bill = self._issue_bill(session, at)
            self._promote(at)
            return bill

        session.state = SessionState.SETTLED
        session.settled_at = at
        session.fee = self._compute_fee(session)
        del self._active_by_pile[session.pile_id]
        bill = self._issue_bill(session, at)
        self._promote(at)
        return bill

    def _issue_bill(self, session: Session, at: datetime) -> Bill:
        bill = Bill(
            id=f"B{len(self._bills) + 1:04d}",
            session_id=session.id,
            pile_id=session.pile_id,
            user_id=session.user_id,
            energy_kwh=session.energy_kwh,
            amount=quantize_fee(session.fee),
            settled_at=at,
        )
        self._bills.append(bill)
        self._bill_by_session[session.id] = bill
        return bill

    # ---------- 电价 ----------

    def update_price_schedule(self, schedule: PriceSchedule) -> None:
        """更换电价表：未结算会话费用立即按新表重算；已出账账单保持原样。"""
        self._price = schedule
        for session in self._sessions.values():
            if session.state is not SessionState.SETTLED:
                session.fee = self._compute_fee(session)

    def _compute_fee(self, session: Session) -> Decimal:
        """由电表读数历史按当前电价表推导费用（首条读数为计费基线）。"""
        total = Decimal("0")
        for prev, cur in zip(session.readings, session.readings[1:]):
            total += self._price.fee_for(prev.at, cur.at, cur.kwh_total - prev.kwh_total)
        return quantize_fee(total)

    # ---------- 对账 ----------

    def reconcile(self, month: str, payments: list[PaymentRecord]) -> ReconReport:
        """与支付渠道对账：month 形如 '2026-10'。"""
        return reconcile(month, self._bills, payments)

    # ---------- 查询 ----------

    @property
    def used_capacity_kw(self) -> Decimal:
        return sum(
            (s.power_kw for s in self._sessions.values() if s.state is SessionState.CHARGING),
            Decimal("0"),
        )

    @property
    def bills(self) -> list[Bill]:
        return list(self._bills)

    def get_session(self, session_id: str) -> Session:
        return self._require_session(session_id)

    def queued_sessions(self, pile_id: str) -> list[Session]:
        return [self._sessions[sid] for sid in self._queues.get(pile_id, ())]

    def _require_session(self, session_id: str) -> Session:
        try:
            return self._sessions[session_id]
        except KeyError:
            raise KeyError(f"unknown session: {session_id}") from None

    def _remove_from_queue(self, session: Session) -> None:
        queue = self._queues.get(session.pile_id)
        if queue and session.id in queue:
            queue.remove(session.id)
