import unittest
from datetime import datetime
from decimal import Decimal

from chargeops import Bill, PaymentRecord, reconcile


def bill(session_id, amount, month="2026-09"):
    return Bill(
        id=f"B-{session_id}",
        session_id=session_id,
        pile_id="P1",
        user_id="u",
        energy_kwh=Decimal("0"),
        amount=Decimal(amount),
        settled_at=datetime.strptime(month + "-15", "%Y-%m-%d"),
    )


class ReconcileTest(unittest.TestCase):
    def test_under_and_over_collected_are_listed_separately(self):
        bills = [
            bill("S1", "100.00"),            # 平账
            bill("S2", "200.00"),            # 少收 50
            bill("S3", "300.00"),            # 多收 50
            bill("S4", "50.00", "2026-08"),  # 非当月，不参与
        ]
        payments = [
            PaymentRecord("S1", Decimal("100.00")),
            PaymentRecord("S2", Decimal("150.00")),
            PaymentRecord("S3", Decimal("350.00")),
            PaymentRecord("S9", Decimal("20.00")),  # 无账单 → 多收
        ]

        report = reconcile("2026-09", bills, payments)

        self.assertFalse(report.is_balanced)
        self.assertEqual(report.matched, ["S1"])

        under = {d.session_id: d for d in report.under_collected}
        self.assertEqual(set(under), {"S2"})
        self.assertEqual(under["S2"].diff, Decimal("-50.00"))

        over = {d.session_id: d for d in report.over_collected}
        self.assertEqual(set(over), {"S3", "S9"})
        self.assertEqual(over["S3"].diff, Decimal("50.00"))
        self.assertEqual(over["S9"].billed, Decimal("0"))
        self.assertEqual(over["S9"].diff, Decimal("20.00"))

        self.assertEqual(report.total_billed, Decimal("600.00"))
        self.assertEqual(report.total_paid, Decimal("620.00"))

    def test_missing_payment_is_under_collected(self):
        report = reconcile("2026-09", [bill("S1", "100.00")], [])
        self.assertEqual(len(report.under_collected), 1)
        self.assertEqual(report.under_collected[0].paid, Decimal("0"))

    def test_multiple_payments_for_one_session_are_summed(self):
        payments = [
            PaymentRecord("S1", Decimal("60.00")),
            PaymentRecord("S1", Decimal("40.00")),
        ]
        report = reconcile("2026-09", [bill("S1", "100.00")], payments)
        self.assertTrue(report.is_balanced)
        self.assertEqual(report.matched, ["S1"])

    def test_balanced_when_everything_matches(self):
        report = reconcile(
            "2026-09",
            [bill("S1", "100.00"), bill("S2", "200.00")],
            [PaymentRecord("S1", Decimal("100.00")), PaymentRecord("S2", Decimal("200.00"))],
        )
        self.assertTrue(report.is_balanced)
        self.assertEqual(report.matched, ["S1", "S2"])


if __name__ == "__main__":
    unittest.main()
