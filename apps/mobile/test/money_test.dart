import 'package:atlas/src/core/money.dart';
import 'package:flutter_test/flutter_test.dart';

/// Mirrors packages/shared-kernel/src/money.test.ts. The two implementations must
/// agree: a client that rounds differently from the server produces a ledger that
/// disagrees with itself.
void main() {
  group('Money.fromDecimalString', () {
    test('parses amounts as they appear in bank SMS alerts', () {
      expect(Money.fromDecimalString('1,234.56', 'NGN').minor, BigInt.from(123456));
      expect(Money.fromDecimalString('5', 'NGN').minor, BigInt.from(500));
      expect(Money.fromDecimalString('.5', 'NGN').minor, BigInt.from(50));
      expect(Money.fromDecimalString('-12.5', 'NGN').minor, BigInt.from(-1250));
    });

    test('rejects excess precision instead of guessing', () {
      expect(
        () => Money.fromDecimalString('1.234', 'NGN'),
        throwsA(isA<InvalidMoneyException>()),
      );
    });

    test('rejects malformed input', () {
      for (final String input in <String>['', '.', 'abc', '1.2.3']) {
        expect(
          () => Money.fromDecimalString(input, 'NGN'),
          throwsA(isA<InvalidMoneyException>()),
          reason: 'should reject "$input"',
        );
      }
    });
  });

  group('Money arithmetic', () {
    test('adds without float drift', () {
      final Money sum = Money.fromDecimalString('0.10', 'NGN') +
          Money.fromDecimalString('0.20', 'NGN');
      expect(sum.toDecimalString(), '0.30');
    });

    test('refuses to mix currencies', () {
      expect(
        () => Money.of(BigInt.one, 'NGN') + Money.of(BigInt.one, 'USD'),
        throwsA(isA<CurrencyMismatchException>()),
      );
    });

    test('survives amounts beyond double precision', () {
      final BigInt huge = BigInt.parse('9007199254740993000');
      expect((Money.of(huge, 'NGN') + Money.of(BigInt.one, 'NGN')).minor,
          huge + BigInt.one);
    });
  });

  group('Money presentation', () {
    test('renders exact decimals', () {
      expect(Money.of(BigInt.from(5), 'NGN').toDecimalString(), '0.05');
      expect(Money.of(BigInt.from(-5), 'NGN').toDecimalString(), '-0.05');
      expect(Money.of(BigInt.from(100), 'NGN').toDecimalString(), '1.00');
    });

    test('round-trips through JSON', () {
      final Money original = Money.of(BigInt.from(-98765), 'NGN');
      expect(Money.fromJson(original.toJson()), original);
    });
  });
}
