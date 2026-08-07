# Atlas mobile client

Android-first Flutter client (ADR-006). iOS follows at M3.5.

## Status: scaffold only, not yet compiled

Flutter is **not installed** on the development machine this was written on, so
nothing here has been run through `flutter analyze`, `flutter test`, or a build.
Treat the Dart as reviewed-but-unverified until the bootstrap below succeeds.

The platform directories (`android/`, and later `ios/`) are deliberately absent and
git-ignored. Hand-writing Gradle and manifest boilerplate is error-prone and
version-specific; `flutter create` generates it correctly for whichever Flutter
version you install.

## Bootstrap

Install Flutter and a JDK first (`brew install --cask flutter temurin`), then:

```bash
./scripts/bootstrap-mobile.sh
```

That generates the Android platform scaffolding around the existing `lib/` and
`test/` sources, then runs `flutter pub get`.

Verify with:

```bash
cd apps/mobile && flutter analyze && flutter test
```

## Structure

```
lib/
  main.dart              entry point
  src/
    app.dart             app shell — canvas-first layout (ARCHITECTURE §8)
    core/money.dart      Dart twin of the shared-kernel Money value object
test/
  money_test.dart        mirrors the TypeScript money tests
```

## Why the client has its own Money type

The device is not a passive display. It parses amounts out of bank SMS alerts and
runs offline against a local ledger, so it can originate money bugs on its own.
`lib/src/core/money.dart` mirrors `packages/shared-kernel/src/money.ts` and the two
test suites assert the same behaviour — a client that rounds differently from the
server produces a ledger that disagrees with itself.

## Coming in M1

The real dependency set (drift for the local read model, riverpod, dio, the SMS
platform channel) is deliberately not guessed at here. It gets resolved against an
actual Flutter install rather than pinned blind.
