// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { admin } from './admin';
import { app } from './app';
import { adminUsers } from './admin-users';
import { auth } from './auth';
import { avatars } from './avatars';
import { chat } from './chat';
import type { AppEnv } from './context';
import { devices } from './devices';
import { helper } from './helper';
import { invites } from './invites';
import { joinRequests } from './join-requests';
import { limitsBrake } from './limits-brake';
import { me } from './me';
import { members } from './members';
import { metrics } from './metrics';
import { onboarding } from './onboarding';
import { recent } from './recent';
import { rooms } from './rooms';
import { rtc } from './rtc';
import { spaces } from './spaces';
import { thumbnails } from './thumbnails';

/** The REST API, mounted under /api. Each route authenticates itself. */
export const api = new Hono<AppEnv>()
  .route('/', auth)
  .route('/', admin)
  .route('/', adminUsers)
  .route('/', onboarding)
  .route('/', me)
  .route('/', avatars)
  .route('/', spaces)
  .route('/', members)
  .route('/', rooms)
  .route('/', chat)
  .route('/', recent)
  .route('/', invites)
  .route('/', joinRequests)
  .route('/', devices)
  .route('/', app)
  .route('/', rtc)
  .route('/', thumbnails)
  .route('/', helper)
  .route('/', metrics)
  .route('/', limitsBrake);
