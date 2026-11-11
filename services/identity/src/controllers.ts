import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Pool } from 'pg';
import { POOL } from './db';
import { AddMemberDto, CreateWorkspaceDto, LoginDto, RefreshDto, SignupDto, UpdateMemberDto } from './dto';
import { Actor, CurrentActor, MinRole, Public } from './guards';
import { IdentityService } from './identity.service';

const meta = (req: Request) => ({ ip: (req.header('x-forwarded-for') ?? '').split(',').pop()?.trim() || req.ip, ua: req.header('user-agent') });

@ApiTags('ops')
@Controller()
export class OpsController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}
  @Public() @Get('healthz') health() { return 'ok'; }
  @Public() @Get('readyz') async ready() {
    try { await this.pool.query('SELECT 1'); return 'ready'; } catch { throw new ServiceUnavailableException('database unreachable'); }
  }
}

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly svc: IdentityService) {}

  @Public() @Post('signup') @ApiOperation({ summary: 'Create an account and its first workspace' })
  signup(@Body() dto: SignupDto, @Req() req: Request) { return this.svc.signup(dto, meta(req)); }

  @Public() @Post('login') @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: Request) { return this.svc.login(dto.email, dto.password, meta(req)); }

  @Public() @Post('refresh') @HttpCode(200) @ApiOperation({ summary: 'Rotate the refresh token and get a new access token' })
  refresh(@Body() dto: RefreshDto) { return this.svc.refresh(dto.refresh_token, dto.workspace_id); }

  @Public() @Post('logout') @HttpCode(204)
  async logout(@Body() dto: RefreshDto) { await this.svc.logout(dto.refresh_token); }
}

@ApiTags('plans')
@Controller('v1/plans')
export class PlansController {
  constructor(private readonly svc: IdentityService) {}
  @Public() @Get() async list() { return { plans: await this.svc.plans() }; }
}

@ApiTags('workspaces') @ApiBearerAuth()
@Controller('v1')
export class WorkspacesController {
  constructor(private readonly svc: IdentityService) {}

  @Get('me') me(@CurrentActor() actor: Actor) { return this.svc.me(actor); }

  @Get('workspaces') async list(@CurrentActor() actor: Actor) { return { workspaces: await this.svc.listWorkspaces(actor.userId) }; }

  @Post('workspaces')
  create(@CurrentActor() actor: Actor, @Body() dto: CreateWorkspaceDto, @Req() req: Request) { return this.svc.createWorkspace(actor, dto.name, meta(req).ip); }

  @Post('workspaces/:id/token') @HttpCode(200) @ApiOperation({ summary: 'Get an access token scoped to another workspace you belong to' })
  switch(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.switchWorkspace(actor, id); }

  @MinRole('viewer') @Get('workspaces/:workspaceId/members')
  async members(@Param('workspaceId', ParseUUIDPipe) ws: string) { return { members: await this.svc.members(ws) }; }

  @MinRole('admin') @Post('workspaces/:workspaceId/members')
  add(@CurrentActor() actor: Actor, @Body() dto: AddMemberDto, @Req() req: Request) { return this.svc.addMember(actor, dto.email, dto.role, meta(req).ip); }

  @MinRole('admin') @Patch('workspaces/:workspaceId/members/:userId')
  update(@CurrentActor() actor: Actor, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: UpdateMemberDto, @Req() req: Request) {
    return this.svc.updateMember(actor, userId, dto.role, meta(req).ip);
  }

  @MinRole('admin') @Delete('workspaces/:workspaceId/members/:userId') @HttpCode(204)
  async remove(@CurrentActor() actor: Actor, @Param('userId', ParseUUIDPipe) userId: string, @Req() req: Request) {
    await this.svc.removeMember(actor, userId, meta(req).ip);
  }
}
