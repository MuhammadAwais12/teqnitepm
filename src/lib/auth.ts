import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, getOAuthState } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { HttpError } from '@/lib/db';
import { acceptInvite, inviteByToken, inviteForEmail, pickColor, roleForNewAccount, setting } from '@/server/account';
import { seedWelcomeProject } from '@/server/seed';

/** Headers the server-side sign-up call uses to pass the invite token / shared code. */
export const INVITE_TOKEN_HEADER = 'x-tt-invite-token';
export const INVITE_CODE_HEADER = 'x-tt-invite-code';

const MAX_AGE = 60 * 60 * 24 * 30; // 30 days, same as the old session

const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

type HookCtx = { headers?: Headers; request?: Request } | null | undefined;

/**
 * Invite token and shared code for the current sign-up.
 * Email sign-up: headers set by the server-side call. Google: the OAuth state.
 * Both are untrusted input; roleForNewAccount validates them (and the email match).
 */
async function inviteInput(ctx: HookCtx): Promise<{ token: string; code: string }> {
  const h = ctx?.headers ?? ctx?.request?.headers;
  let token = h?.get(INVITE_TOKEN_HEADER) || '';
  const code = h?.get(INVITE_CODE_HEADER) || '';
  if (!token) {
    const state = await getOAuthState<{ invite?: unknown }>().catch(() => null);
    if (typeof state?.invite === 'string') token = state.invite;
  }
  return { token: token.slice(0, 100), code: code.slice(0, 100) };
}

const forbidden = (e: unknown): never => {
  if (e instanceof HttpError) throw new APIError('FORBIDDEN', { message: e.message, code: 'INVITE_REQUIRED' });
  throw e;
};

export const auth = betterAuth({
  appName: 'Teqnite Tasks',
  secret: process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || process.env.AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || undefined,
  trustedOrigins: [process.env.BETTER_AUTH_URL, process.env.AUTH_URL, process.env.NEXT_PUBLIC_APP_URL, 'http://localhost:3000']
    .filter((o): o is string => !!o)
    .map((o) => o.replace(/\/$/, '')),

  database: prismaAdapter(prisma, { provider: 'postgresql' }),

  advanced: {
    cookiePrefix: 'tt',
    database: { generateId: 'uuid' }, // users.id and auth table ids are UUID columns
  },

  user: {
    additionalFields: {
      // input: false → clients can never set these through Better Auth endpoints
      role: { type: 'string', required: false, defaultValue: 'member', input: false },
      color: { type: 'string', required: false, defaultValue: '#5b6cff', input: false },
      active: { type: 'boolean', required: false, defaultValue: true, input: false },
    },
  },

  session: {
    expiresIn: MAX_AGE,
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    autoSignIn: true,
    requireEmailVerification: false,
    // Existing hashes are bcrypt (backfilled into accounts.password unchanged).
    password: {
      hash: (password) => bcrypt.hash(password, 10),
      verify: ({ hash, password }) => bcrypt.compare(password, hash),
    },
  },

  socialProviders: googleEnabled
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          prompt: 'select_account',
          mapProfileToUser: (profile) => ({
            email: String(profile.email || '').trim().toLowerCase(),
            name: profile.name || String(profile.email || '').split('@')[0],
            image: profile.picture || '',
          }),
        },
      }
    : {},

  account: {
    accountLinking: {
      // Old flow linked Google to an existing account with the same email.
      enabled: true,
      trustedProviders: ['google'],
    },
  },

  databaseHooks: {
    user: {
      create: {
        // Invite-only registration for every path (email and Google).
        before: async (user, ctx) => {
          const email = String(user.email || '').trim().toLowerCase();
          const { token, code } = await inviteInput(ctx as HookCtx);
          const { role } = await roleForNewAccount({ email, token, code }).catch(forbidden);
          const n = await prisma.user.count();
          return {
            data: { ...user, email, image: user.image || '', role, color: pickColor(n), active: true },
          };
        },
        after: async (user, ctx) => {
          const { token } = await inviteInput(ctx as HookCtx);
          const invite = (await inviteByToken(token)) || (await inviteForEmail(user.email));
          if (invite && invite.email.toLowerCase() === user.email.toLowerCase()) await acceptInvite(invite, user.id);
          if (user.role === 'owner' && (await prisma.user.count()) === 1) {
            await setting('invite_code');
            await setting('guest_invite_code');
            await seedWelcomeProject({
              id: user.id,
              name: user.name,
              email: user.email,
              role: 'owner',
              color: String(user.color),
              avatar_url: user.image || '',
              active: true,
            });
          }
        },
      },
    },
    session: {
      create: {
        // Deactivated accounts cannot sign in (email or Google).
        before: async (session) => {
          const u = await prisma.user.findUnique({ where: { id: session.userId }, select: { active: true } });
          if (!u?.active) throw new APIError('FORBIDDEN', { message: 'This account has been deactivated', code: 'ACCOUNT_DEACTIVATED' });
        },
      },
    },
  },

  onAPIError: {
    errorURL: '/login',
  },

  plugins: [nextCookies()], // must stay last
});

export type AuthSession = typeof auth.$Infer.Session;
