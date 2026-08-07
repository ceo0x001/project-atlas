import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TenantScope } from './tenant-scope';

@Global()
@Module({
  providers: [PrismaService, TenantScope],
  exports: [PrismaService, TenantScope],
})
export class PrismaModule {}
