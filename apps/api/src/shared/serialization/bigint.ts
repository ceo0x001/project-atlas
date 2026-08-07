/**
 * Teach JSON.stringify how to handle BigInt.
 *
 * Money is BigInt minor units everywhere (ADR-003), and Prisma returns BigInt for
 * those columns. Without this, the first response carrying an amount throws
 * "Do not know how to serialize a BigInt" — at runtime, in production, on the one
 * endpoint that matters.
 *
 * It serialises to a *string*, never a number: routing a kobo amount through an
 * IEEE-754 double is exactly the failure this codebase is built to prevent.
 * Clients parse these back into their own integer type.
 *
 * Patching a global prototype is a deliberate exception, justified because the
 * alternative — remembering to convert at every boundary — fails silently.
 */
export function installBigIntSerializer(): void {
  const prototype = BigInt.prototype as unknown as { toJSON?: () => string };
  if (prototype.toJSON) return;

  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function toJSON(this: bigint): string {
      return this.toString();
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
