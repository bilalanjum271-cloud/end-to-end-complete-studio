import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { CONFIG, Config } from './config';
import type { Role } from './dto';

export interface Actor {
  userId: string;
  workspaceId: string;
  role: Role;
  plan: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const PUBLIC = 'public';
export const Public = () => SetMetadata(PUBLIC, true);
export const MIN_ROLE = 'minRole';
/** Requires the caller's role in the current workspace to be at least `role`. */
export const MinRole = (role: Role) => SetMetadata(MIN_ROLE, role);

const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };
export const atLeast = (have: Role, need: Role) => RANK[have] >= RANK[need];

/**
 * Every request must arrive through the gateway (X-Gateway-Token). The gateway has
 * already verified the access token and injected the tenant headers, which is the
 * only place identity comes from; clients cannot set them.
 */
@Injectable()
export class GatewayGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, @Inject(CONFIG) private readonly cfg: Config) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { actor?: Actor }>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (req.path === '/healthz' || req.path === '/readyz') return true; // kubelet probes
    const token = req.header('x-gateway-token') ?? '';
    if (!safeEq(token, this.cfg.gatewayToken)) throw new UnauthorizedException('requests must come through the gateway');

    const userId = req.header('x-user-id') ?? '';
    if (!UUID.test(userId)) {
      if (isPublic) return true;
      throw new UnauthorizedException('authentication required');
    }
    const actor: Actor = {
      userId,
      workspaceId: req.header('x-workspace-id') ?? '',
      role: (req.header('x-role') as Role) ?? 'viewer',
      plan: req.header('x-plan') ?? 'starter',
    };
    req.actor = actor;

    const need = this.reflector.getAllAndOverride<Role>(MIN_ROLE, [ctx.getHandler(), ctx.getClass()]);
    if (need) {
      // Tenant isolation: a workspace-scoped route may only address the caller's current workspace.
      const target = req.params?.workspaceId;
      if (!UUID.test(actor.workspaceId) || (target && target !== actor.workspaceId)) {
        throw new ForbiddenException('this workspace is not the one your session is scoped to');
      }
      if (!RANK[actor.role] || !atLeast(actor.role, need)) throw new ForbiddenException(`requires role ${need} or higher`);
    }
    return true;
  }
}

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  return ctx.switchToHttp().getRequest<Request & { actor: Actor }>().actor;
});
