import unittest
from datetime import datetime, time, timedelta
from decimal import Decimal

from chargeops import ChargingStation, PriceSchedule, PriceSegment, SessionState

T0 = datetime(2026, 10, 1, 10, 0, 0)


def at(**kwargs):
    return T0 + timedelta(**kwargs)


def flat_schedule(price="1.0"):
    return PriceSchedule([PriceSegment(time(0, 0), Decimal(price))])


def day_night_schedule():
    return PriceSchedule([
        PriceSegment(time(0, 0), Decimal("1.0")),
        PriceSegment(time(12, 0), Decimal("2.0")),
    ])


def make_station(capacity="100", schedule=None):
    return ChargingStation("ST-1", Decimal(capacity), schedule or flat_schedule())


class QueueTest(unittest.TestCase):
    def test_same_pile_one_session_at_a_time_fifo(self):
        # 晚高峰：两台车同时提交同一个充电位，先提交的先充，后者补位
        st = make_station(capacity="500")
        s1 = st.submit_start("r1", "P1", "user-A", Decimal("60"), at(seconds=0))
        s2 = st.submit_start("r2", "P1", "user-B", Decimal("60"), at(seconds=1))

        self.assertEqual(st.get_session(s1).state, SessionState.CHARGING)
        self.assertEqual(st.get_session(s2).state, SessionState.QUEUED)
        self.assertEqual([s.id for s in st.queued_sessions("P1")], [s2])

        # A 结算离场后，B 自动补位开工
        st.stop_session(s1, at(minutes=30))
        self.assertEqual(st.get_session(s2).state, SessionState.CHARGING)

    def test_submit_is_idempotent_by_request_id(self):
        st = make_station()
        s1 = st.submit_start("r1", "P1", "user-A", Decimal("60"), at(seconds=0))
        again = st.submit_start("r1", "P1", "user-A", Decimal("60"), at(seconds=0))
        self.assertEqual(s1, again)
        self.assertEqual(len(st.queued_sessions("P1")), 0)

    def test_transformer_capacity_gate(self):
        # 容量 100：60 + 60 超容，第二个排队；40 的能塞进余量
        st = make_station(capacity="100")
        s1 = st.submit_start("r1", "P1", "user-A", Decimal("60"), at(seconds=0))
        s2 = st.submit_start("r2", "P2", "user-B", Decimal("60"), at(seconds=1))
        s3 = st.submit_start("r3", "P3", "user-C", Decimal("40"), at(seconds=2))

        self.assertEqual(st.get_session(s1).state, SessionState.CHARGING)
        self.assertEqual(st.get_session(s2).state, SessionState.QUEUED)
        self.assertEqual(st.get_session(s3).state, SessionState.CHARGING)
        self.assertEqual(st.used_capacity_kw, Decimal("100"))

        # A 结束释放 60，B 按提交先后补上
        st.stop_session(s1, at(minutes=30))
        self.assertEqual(st.get_session(s2).state, SessionState.CHARGING)
        self.assertEqual(st.used_capacity_kw, Decimal("100"))


class MeterReportTest(unittest.TestCase):
    def setUp(self):
        self.st = make_station()
        self.sid = self.st.submit_start("r1", "P1", "user-A", Decimal("60"), T0)

    def test_duplicate_report_not_counted_twice(self):
        self.st.ingest_report("m1", self.sid, at(minutes=0), Decimal("0"))
        self.st.ingest_report("m2", self.sid, at(minutes=30), Decimal("6"))
        self.assertFalse(self.st.ingest_report("m2", self.sid, at(minutes=30), Decimal("6")))

        session = self.st.get_session(self.sid)
        self.assertEqual(session.energy_kwh, Decimal("6"))
        self.assertEqual(session.fee, Decimal("6.00"))

    def test_offline_keeps_unsettled_sessions_and_resumes_billing(self):
        st = self.st
        st.ingest_report("m1", self.sid, at(minutes=0), Decimal("0"))
        st.ingest_report("m2", self.sid, at(minutes=30), Decimal("6"))

        # 站控断网：未结算会话原样留住
        st.set_online(False)
        self.assertEqual(st.get_session(self.sid).state, SessionState.CHARGING)
        self.assertIn(st.get_session(self.sid), st.held_sessions)

        # 恢复后站控重放缓存上报：重复的不算两次
        st.set_online(True)
        st.ingest_report("m1", self.sid, at(minutes=0), Decimal("0"))
        st.ingest_report("m2", self.sid, at(minutes=30), Decimal("6"))
        self.assertEqual(st.get_session(self.sid).energy_kwh, Decimal("6"))
        self.assertEqual(st.get_session(self.sid).fee, Decimal("6.00"))

        # 恢复后接着计费
        st.ingest_report("m3", self.sid, at(minutes=60), Decimal("12"))
        self.assertEqual(st.get_session(self.sid).energy_kwh, Decimal("12"))
        self.assertEqual(st.get_session(self.sid).fee, Decimal("12.00"))

    def test_rejects_bad_reports(self):
        with self.assertRaises(ValueError):
            self.st.ingest_report("m1", "no-such-session", at(), Decimal("0"))
        self.st.ingest_report("m1", self.sid, at(minutes=10), Decimal("5"))
        with self.assertRaises(ValueError):  # 表码倒退
            self.st.ingest_report("m2", self.sid, at(minutes=20), Decimal("4"))
        with self.assertRaises(ValueError):  # 时间倒退
            self.st.ingest_report("m3", self.sid, at(minutes=5), Decimal("6"))


class PricingTest(unittest.TestCase):
    def test_unsettled_fee_recomputed_on_price_change_settled_bill_frozen(self):
        st = make_station(capacity="200", schedule=flat_schedule("1.0"))
        s1 = st.submit_start("r1", "P1", "user-A", Decimal("60"), T0)
        s2 = st.submit_start("r2", "P2", "user-B", Decimal("60"), T0)
        for sid in (s1, s2):
            st.ingest_report(f"{sid}-m1", sid, at(minutes=0), Decimal("0"))
            st.ingest_report(f"{sid}-m2", sid, at(hours=1), Decimal("10"))
        self.assertEqual(st.get_session(s1).fee, Decimal("10.00"))

        # 电价从 1 元涨到 5 元：未结算会话费用马上重算
        st.update_price_schedule(flat_schedule("5.0"))
        self.assertEqual(st.get_session(s1).fee, Decimal("50.00"))
        self.assertEqual(st.get_session(s2).fee, Decimal("50.00"))

        # s1 出账 50 元；之后电价再变，账单保持原样
        bill = st.stop_session(s1, at(hours=1, minutes=5))
        self.assertEqual(bill.amount, Decimal("50.00"))
        st.update_price_schedule(flat_schedule("9.0"))
        self.assertEqual(st.bills[0].amount, Decimal("50.00"))
        # 未结算的 s2 仍按最新电价重算
        self.assertEqual(st.get_session(s2).fee, Decimal("90.00"))

    def test_fee_follows_time_of_use_segments(self):
        st = make_station(schedule=day_night_schedule())
        sid = st.submit_start("r1", "P1", "user-A", Decimal("60"), T0)
        st.ingest_report("m1", sid, datetime(2026, 10, 1, 11, 0), Decimal("0"))
        st.ingest_report("m2", sid, datetime(2026, 10, 1, 13, 0), Decimal("10"))
        # 11-13 点跨 12 点时段边界：5 度 @1 元 + 5 度 @2 元
        self.assertEqual(st.get_session(sid).fee, Decimal("15.00"))


class SettlementTest(unittest.TestCase):
    def test_stop_is_idempotent(self):
        st = make_station()
        sid = st.submit_start("r1", "P1", "user-A", Decimal("60"), T0)
        st.ingest_report("m1", sid, at(minutes=0), Decimal("0"))
        st.ingest_report("m2", sid, at(minutes=30), Decimal("6"))
        bill1 = st.stop_session(sid, at(minutes=30))
        bill2 = st.stop_session(sid, at(minutes=30))
        self.assertEqual(bill1.id, bill2.id)
        self.assertEqual(len(st.bills), 1)
        self.assertEqual(bill1.amount, Decimal("6.00"))
        self.assertEqual(bill1.energy_kwh, Decimal("6"))

    def test_queued_session_can_be_cancelled(self):
        st = make_station()
        st.submit_start("r1", "P1", "user-A", Decimal("60"), T0)
        s2 = st.submit_start("r2", "P1", "user-B", Decimal("60"), at(seconds=1))
        bill = st.stop_session(s2, at(minutes=5))
        self.assertEqual(bill.amount, Decimal("0"))
        self.assertEqual(st.queued_sessions("P1"), [])


if __name__ == "__main__":
    unittest.main()
