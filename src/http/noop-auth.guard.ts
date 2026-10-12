import type { CanActivate } from '@nestjs/common';
import { Injectable } from '@nestjs/common';

/**
 * §2 explicitly permits the authentication mechanism to be a stub for this
 * exercise, and this is that stub — visible, deliberate, and impossible to
 * mistake for finished work.
 *
 * It is a real guard rather than no guard at all so that enabling real auth
 * later means replacing one class, not retrofitting `@UseGuards` across every
 * controller.
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
