import 'package:intl/intl.dart';

/// Money — the Dart twin of `@atlas/shared-kernel`'s Money (ADR-003).
///
/// The client is not a passive display layer: it parses amounts out of bank SMS
/// alerts and works offline against a local ledger. That makes it a place where
/// money bugs can originate, so the same invariant applies here — integer minor
/// units in a [BigInt], never a `double`.
///
/// Kept deliberately in step with packages/shared-kernel/src/money.ts.
class CurrencyMismatchException implements Exception {
  const CurrencyMismatchException(this.left, this.right);

  final String left;
  final String right;

  @override
  String toString() =>
      'CurrencyMismatchException: cannot combine $left with $right without an explicit rate';
}

class InvalidMoneyException implements Exception {
  const InvalidMoneyException(this.message);

  final String message;

  @override
  String toString() => 'InvalidMoneyException: $message';
}

/// Decimal places per supported currency. Mirrors the server-side registry.
const Map<String, int> _currencyExponents = <String, int>{
  'NGN': 2,
  'USD': 2,
};

const Map<String, String> _currencySymbols = <String, String>{
  'NGN': '₦',
  'USD': '\$',
};

class Money implements Comparable<Money> {
  const Money._(this.minor, this.currency);

  final BigInt minor;
  final String currency;

  static int _exponentOf(String currency) {
    final int? exponent = _currencyExponents[currency];
    if (exponent == null) {
      throw InvalidMoneyException('Unsupported currency $currency');
    }
    return exponent;
  }

  factory Money.of(BigInt minor, String currency) {
    _exponentOf(currency);
    return Money._(minor, currency);
  }

  factory Money.zero(String currency) => Money.of(BigInt.zero, currency);

  /// Parses a major-unit decimal string such as `"1,234.56"` into minor units.
  ///
  /// Rejects more precision than the currency supports rather than silently
  /// rounding: in an SMS parser, unexpected precision means the pattern matched
  /// something other than an amount, and guessing would corrupt the ledger.
  factory Money.fromDecimalString(String value, String currency) {
    final int exponent = _exponentOf(currency);
    final String cleaned = value.trim().replaceAll(RegExp(r'[,\s_]'), '');
    final RegExpMatch? match =
        RegExp(r'^([+-]?)(\d*)(?:\.(\d*))?$').firstMatch(cleaned);

    if (match == null) {
      throw InvalidMoneyException('"$value" is not a valid decimal amount');
    }

    final String sign = match.group(1) ?? '';
    final String whole = match.group(2) ?? '';
    final String fraction = match.group(3) ?? '';

    if (whole.isEmpty && fraction.isEmpty) {
      throw InvalidMoneyException('"$value" is not a valid decimal amount');
    }
    if (fraction.length > exponent) {
      throw InvalidMoneyException(
        '"$value" has ${fraction.length} decimal places but $currency supports $exponent',
      );
    }

    final BigInt magnitude =
        BigInt.parse((whole.isEmpty ? '0' : whole) + fraction.padRight(exponent, '0'));

    return Money._(sign == '-' ? -magnitude : magnitude, currency);
  }

  void _assertSameCurrency(Money other) {
    if (other.currency != currency) {
      throw CurrencyMismatchException(currency, other.currency);
    }
  }

  Money operator +(Money other) {
    _assertSameCurrency(other);
    return Money._(minor + other.minor, currency);
  }

  Money operator -(Money other) {
    _assertSameCurrency(other);
    return Money._(minor - other.minor, currency);
  }

  Money operator -() => Money._(-minor, currency);

  Money abs() => minor.isNegative ? -this : this;

  bool get isZero => minor == BigInt.zero;

  bool get isNegative => minor.isNegative;

  @override
  int compareTo(Money other) {
    _assertSameCurrency(other);
    return minor.compareTo(other.minor);
  }

  /// Exact decimal representation, never lossy.
  String toDecimalString() {
    final int exponent = _exponentOf(currency);
    final BigInt divisor = BigInt.from(10).pow(exponent);
    final BigInt magnitude = minor.abs();
    final String sign = minor.isNegative ? '-' : '';
    final BigInt whole = magnitude ~/ divisor;

    if (exponent == 0) {
      return '$sign$whole';
    }

    final String fraction =
        (magnitude % divisor).toString().padLeft(exponent, '0');
    return '$sign$whole.$fraction';
  }

  /// Display string, e.g. `₦1,234.56`. Groups the integer part as a [BigInt] so
  /// no intermediate `double` ever exists.
  String format({String locale = 'en_NG'}) {
    final int exponent = _exponentOf(currency);
    final BigInt divisor = BigInt.from(10).pow(exponent);
    final BigInt magnitude = minor.abs();
    final String sign = minor.isNegative ? '-' : '';
    final String symbol = _currencySymbols[currency] ?? currency;
    final String groupedWhole =
        NumberFormat.decimalPattern(locale).format(magnitude ~/ divisor);

    if (exponent == 0) {
      return '$sign$symbol$groupedWhole';
    }

    final String fraction =
        (magnitude % divisor).toString().padLeft(exponent, '0');
    return '$sign$symbol$groupedWhole.$fraction';
  }

  Map<String, String> toJson() =>
      <String, String>{'minor': minor.toString(), 'currency': currency};

  factory Money.fromJson(Map<String, dynamic> json) => Money.of(
        BigInt.parse(json['minor'] as String),
        json['currency'] as String,
      );

  @override
  bool operator ==(Object other) =>
      other is Money && other.minor == minor && other.currency == currency;

  @override
  int get hashCode => Object.hash(minor, currency);

  @override
  String toString() => '${toDecimalString()} $currency';
}
