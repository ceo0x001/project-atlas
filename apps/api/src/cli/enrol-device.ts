// Enrol one of your own devices and print its token.
//
//   node dist/cli/enrol-device.js --phone 08012345678 --platform ANDROID --role CLIENT_AND_INGESTION_NODE
//
// This is how a device gets a token on a single-user deployment (ADR-009). Phone sign-in by
// one-time code exists to authenticate someone you do not know; when the only user is the
// operator there is nobody to authenticate, so the code, the SMS gateway, and the NCC sender-ID
// registration that gateway would require are all ceremony.
//
// It runs locally against the database, which is the whole security model: it takes a phone
// number and mints a credential with no proof of anything, so it must never be reachable over
// HTTP. `DeviceEnrolmentService` has deliberately never had a route for exactly this reason.
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import { newId, type UserId } from '@atlas/shared-kernel';
import { AppModule } from '../app.module';
import { DeviceEnrolmentService } from '../modules/identity';
import { normalisePhone } from '../modules/identity/domain/otp';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantScope } from '../shared/prisma/tenant-scope';

const PLATFORMS = ['ANDROID', 'IOS'] as const;
const ROLES = ['CLIENT', 'INGESTION_NODE', 'CLIENT_AND_INGESTION_NODE'] as const;

type Platform = (typeof PLATFORMS)[number];
type Role = (typeof ROLES)[number];

function usage(): never {
  process.stderr.write(
    [
      'usage: node dist/cli/enrol-device.js --phone <number> [options]',
      '',
      `  --platform   ${PLATFORMS.join(' | ')}   (default ANDROID)`,
      `  --role       ${ROLES.join(' | ')}   (default CLIENT_AND_INGESTION_NODE)`,
      '  --label      a name for the device, e.g. "Pixel 8a"',
      '',
      'Creates the user on first run. Prints the device token once — it is not stored',
      'in plaintext and cannot be retrieved again.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

function takeFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;

  const value = args[index + 1];
  args.splice(index, 2);

  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rawPhone = takeFlag(args, '--phone');
  const platformArg = takeFlag(args, '--platform') ?? 'ANDROID';
  const roleArg = takeFlag(args, '--role') ?? 'CLIENT_AND_INGESTION_NODE';
  const label = takeFlag(args, '--label');

  if (rawPhone === undefined) usage();

  const phoneE164 = normalisePhone(rawPhone);
  if (phoneE164 === null) {
    process.stderr.write(`'${rawPhone}' is not a Nigerian mobile number\n`);
    process.exit(2);
  }

  if (!isPlatform(platformArg) || !isRole(roleArg)) usage();

  // An iOS device cannot read SMS (ADR-006). Refused here as well as in the HTTP schema,
  // because a device enrolled as an ingestion node it cannot be would wait forever for alerts.
  if (platformArg === 'IOS' && roleArg !== 'CLIENT') {
    process.stderr.write(
      'an iOS device cannot be an ingestion node: iOS does not permit SMS access\n',
    );
    process.exit(2);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });

  try {
    const prisma = app.get(PrismaService);
    const tenantScope = app.get(TenantScope);
    const enrolment = app.get(DeviceEnrolmentService);

    const userId = await resolveUser(prisma, tenantScope, phoneE164);

    const enrolled = await enrolment.enrol({
      userId,
      platform: platformArg,
      role: roleArg,
      ...(label === undefined ? {} : { model: label }),
    });

    process.stdout.write(
      [
        '',
        'Device enrolled.',
        '',
        `  user     ${userId}`,
        `  device   ${enrolled.deviceId}`,
        `  token    ${enrolled.token}`,
        '',
        'The token is shown once and is not recoverable — only its hash is stored.',
        'Send it as: Authorization: Bearer <token>',
        '',
      ].join('\n'),
    );
  } finally {
    await app.close();
  }
}

/**
 * Finds the user behind a phone number, creating one on first run.
 *
 * Goes through `phone_identities` rather than `users` for the same reason the sign-in service
 * does: `users` is under row-level security keyed on the id this lookup is trying to discover,
 * so reading it by phone matches nothing and would create a duplicate.
 */
async function resolveUser(
  prisma: PrismaService,
  tenantScope: TenantScope,
  phoneE164: string,
): Promise<UserId> {
  const existing = await prisma.phoneIdentity.findUnique({
    where: { phoneE164 },
    select: { userId: true },
  });

  if (existing) return existing.userId as UserId;

  const userId = newId<'UserId'>();

  await tenantScope.run(userId, (tx) => tx.user.create({ data: { id: userId, phoneE164 } }));
  await prisma.phoneIdentity.create({ data: { phoneE164, userId } });

  process.stdout.write(`Created user ${userId} for ${phoneE164}\n`);

  return userId;
}

function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
