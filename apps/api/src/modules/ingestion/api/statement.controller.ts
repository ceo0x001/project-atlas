import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { AccountId, CurrencyCode, InstitutionId } from '@atlas/shared-kernel';
import { type AuthenticatedRequest, DeviceAuthGuard } from '@modules/identity';
import { TenantScope } from '@shared/prisma/tenant-scope';
import { ZodValidationPipe } from '@shared/validation/zod-validation.pipe';
import { StatementImportService } from '../application/statement-import.service';
import { type ImportStatementRequest, importStatementSchema } from './statement.dto';

/**
 * Statement upload, for backfilling history the SMS feed never saw.
 *
 * The response distinguishes three outcomes, and the distinction is the point:
 *
 *   - `COMPLETED` — the statement's own arithmetic closed and everything was imported.
 *   - `REJECTED` — it was read but did not add up, so **nothing** was imported. The reason
 *     names the line and both figures so a person can go and look.
 *   - `FAILED` — it could not be read at all, which calls for a different fix from a file that
 *     was read and disagreed with itself.
 *
 * There is deliberately no way to force a partial import. A statement that does not reconcile
 * is a parse we do not understand, and importing the rows we happen to have read would produce
 * a total wrong by exactly the ones we missed — invisibly.
 */
@Controller('v1/statements')
@UseGuards(DeviceAuthGuard)
export class StatementController {
  constructor(
    private readonly imports: StatementImportService,
    private readonly tenantScope: TenantScope,
  ) {}

  @Post('import')
  @HttpCode(200)
  async importStatement(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(importStatementSchema)) body: ImportStatementRequest,
  ) {
    return this.imports.import({
      userId: request.principal.userId,
      accountId: body.accountId as AccountId,
      institutionId: (body.institutionId ?? null) as InstitutionId | null,
      filename: body.filename,
      content: body.content,
      currency: body.currency as CurrencyCode,
      statedOpeningMinor:
        body.statedOpeningMinor == null ? undefined : BigInt(body.statedOpeningMinor),
      statedClosingMinor:
        body.statedClosingMinor == null ? undefined : BigInt(body.statedClosingMinor),
    });
  }

  /** Past imports, so a rejection can be read back rather than only seen once. */
  @Get()
  async history(@Req() request: AuthenticatedRequest) {
    const rows = await this.tenantScope.run(request.principal.userId, (tx) =>
      tx.statementImport.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          filename: true,
          status: true,
          rowCount: true,
          observationCount: true,
          reconciled: true,
          failureReason: true,
          createdAt: true,
          completedAt: true,
        },
      }),
    );

    return { imports: rows };
  }
}
