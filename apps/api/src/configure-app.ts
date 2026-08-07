import type { NestExpressApplication } from '@nestjs/platform-express';
import { MAX_STATEMENT_BYTES } from '@modules/ingestion';

/**
 * Runtime configuration every boot of the application needs.
 *
 * Shared rather than living in `main.ts`, for the reason the BigInt serializer taught: a
 * setting applied only in the entry point holds for the deployed process and for nothing else
 * that starts the app — so integration tests exercise a subtly different server from the one
 * that ships, and the difference surfaces as a confusing status code rather than as a failure
 * anyone can read.
 */

/**
 * Express defaults to a 100 kB JSON body, which is smaller than a real bank statement: at
 * roughly 80 bytes a row that ceiling is about 1,250 transactions, and a year of a busy account
 * exceeds it. The limit is raised to fit `MAX_STATEMENT_BYTES` plus room for the surrounding
 * JSON envelope.
 *
 * This widens the request surface on every endpoint, which is the cost. It is bounded because
 * each endpoint's own schema caps what it will accept — the sync endpoint by batch size, the
 * statement endpoint by content length — so the body parser is a backstop rather than the only
 * limit.
 */
/**
 * Twice the content limit, plus envelope. The factor of two is not slack: a CSV is mostly
 * newlines, and JSON encodes each one as the two characters `\n`, so a 1 MiB file arrives as a
 * body of roughly 2 MiB. Allowing only `MAX_STATEMENT_BYTES + envelope` made the body parser
 * bind *before* the schema, so a file inside the documented limit was refused with 413 and the
 * documented limit was unreachable — the outer guard has to be looser than the inner one, or
 * the inner one is decoration.
 */
const JSON_BODY_LIMIT_BYTES = MAX_STATEMENT_BYTES * 2 + 16 * 1024;

export function configureApp(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT_BYTES });
}
