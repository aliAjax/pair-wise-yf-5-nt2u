import unittest
from datetime import datetime, time
from decimal import Decimal

from chargeops.pricing import PriceSchedule, PriceSegment


def dt(day, hour, minute=0):
    return datetime(2026, 10, day, hour, minute)


class PriceScheduleTest(unittest.TestCase):
    def setUp(self):
        # 00:00-12:00 每度 1 元，12:00-24:00 每度 2 元
        self.schedule = PriceSchedule([
            PriceSegment(time(0, 0), Decimal("1.0")),
            PriceSegment(time(12, 0), Decimal("2.0")),
        ])

    def test_flat_interval(self):
        fee = self.schedule.fee_for(dt(1, 10), dt(1, 11), Decimal("10"))
        self.assertEqual(fee, Decimal("10.0"))

    def test_interval_crossing_segment_boundary_splits_energy(self):
        # 11:00-13:00 充 10 度，均摊为 5 度 @1 元 + 5 度 @2 元
        fee = self.schedule.fee_for(dt(1, 11), dt(1, 13), Decimal("10"))
        self.assertEqual(fee, Decimal("15.0"))

    def test_interval_crossing_midnight(self):
        schedule = PriceSchedule([
            PriceSegment(time(0, 0), Decimal("1.0")),
            PriceSegment(time(23, 0), Decimal("2.0")),
        ])
        # 22:00-24:00 充 4 度：22-23 点 2 度 @1 元，23-24 点 2 度 @2 元
        fee = schedule.fee_for(dt(1, 22), dt(2, 0), Decimal("4"))
        self.assertEqual(fee, Decimal("6.0"))

    def test_price_at_wraps_to_last_segment(self):
        self.assertEqual(self.schedule.price_at(dt(1, 23, 59)), Decimal("2.0"))
        self.assertEqual(self.schedule.price_at(dt(1, 0, 0)), Decimal("1.0"))

    def test_zero_energy_or_zero_duration_is_free(self):
        self.assertEqual(self.schedule.fee_for(dt(1, 10), dt(1, 11), Decimal("0")), Decimal("0"))
        self.assertEqual(self.schedule.fee_for(dt(1, 10), dt(1, 10), Decimal("5")), Decimal("0"))

    def test_rejects_invalid_input(self):
        with self.assertRaises(ValueError):
            PriceSchedule([])
        with self.assertRaises(ValueError):
            PriceSchedule([
                PriceSegment(time(8, 0), Decimal("1")),
                PriceSegment(time(8, 0), Decimal("2")),
            ])
        with self.assertRaises(ValueError):
            self.schedule.fee_for(dt(1, 11), dt(1, 10), Decimal("1"))
        with self.assertRaises(ValueError):
            self.schedule.fee_for(dt(1, 10), dt(1, 11), Decimal("-1"))


if __name__ == "__main__":
    unittest.main()
