import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { DeviceAuthenticator } from '../application/device-authenticator';
import type { DevicePrincipal } from '../domain/device-principal';
import { bearerTokenFrom } from '../domain/device-token';

/** A request that has passed DeviceAuthGuard carries its resolved principal. */
export interface AuthenticatedRequest extends Request {
  principal: DevicePrincipal;
}

/**
 * Authenticates device-facing endpoints from an `Authorization: Bearer` header.
 *
 * The resolved principal is the *only* source of user identity for downstream
 * handlers. A user id in a request body or header is never trusted — accepting one
 * would turn the sync endpoint into a way to write into any account.
 */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly authenticator: DeviceAuthenticator) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerTokenFrom(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const principal = await this.authenticator.authenticate(token);

    if (!principal) {
      // Deliberately indistinguishable from a revoked or unknown token: telling a
      // caller which of those it was is free reconnaissance.
      throw new UnauthorizedException('Invalid device credentials');
    }

    request.principal = principal;

    return true;
  }
}
