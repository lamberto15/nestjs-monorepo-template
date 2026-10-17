import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ApiNotFoundResponse } from '@nestjs/swagger';
import type { IamEnv } from '../iam.env.js';

/** The deployment switches (iam.env.ts) that turn a set of routes off. */
export type DeploymentSwitch = 'IMPERSONATION' | 'AUTH_MFA' | 'API_CLIENTS';

const SWITCH = 'iam:deployment-switch';

/**
 * Refuses the route with 404 `feature_off` when its switch is off: the
 * route doesn't exist for this deployment (as with PASSKEYS=off). It runs
 * after the global guards, so a caller that isn't signed in still gets 401
 * and learns nothing about the deployment.
 */
@Injectable()
export class DeploymentSwitchGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService<IamEnv, true>,
  ) {}

  canActivate(context: ExecutionContext) {
    const name = this.reflector.getAllAndOverride<DeploymentSwitch | undefined>(
      SWITCH,
      [context.getHandler(), context.getClass()],
    );
    if (name && !this.config.get(name, { infer: true })) {
      throw new NotFoundException({
        code: 'feature_off',
        message: `Not available here: ${name} is off in this deployment.`,
      });
    }
    return true;
  }
}

/** The route exists only while the switch is on (DeploymentSwitchGuard). */
export const RequiresSwitch = (name: DeploymentSwitch) =>
  applyDecorators(
    SetMetadata(SWITCH, name),
    UseGuards(DeploymentSwitchGuard),
    ApiNotFoundResponse({
      description: `feature_off: ${name}=off in this deployment.`,
    }),
  );
