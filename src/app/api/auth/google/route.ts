import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { googleEnabled, authorizeUrl, originOf } from '@/server/google';
import { cookieOptions, legacyAuth } from '@/server/auth';
import { auth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOT_CONFIGURED = 'Google sign-in is not configured for this workspace.';

/** Better Auth error codes from the Google callback → the messages the login page already showed. */
function messageFor(code: string, description: string): string {
  if (code === 'INVITE_REQUIRED' || code === 'ACCOUNT_DEACTIVATED') return description || 'Google sign-in failed. Please try again or use your email and password.';
  if (code === 'access_denied') return 'Google sign-in was cancelled.';
  if (code === 'state_not_found' || code === 'state_mismatch' || code === 'please_restart_the_process') return 'That sign-in link expired. Please try again.';
  return 'Google sign-in failed. Please try again or use your email and password.';
}

export async function GET(req: Request) {
  const origin = originOf(req);
  const url = new URL(req.url);
  const toLogin = (message: string) => NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(message)}`);

  if (legacyAuth()) {
    // Legacy flow (rollback): custom state cookie + /api/auth/google/callback
    if (!googleEnabled()) return toLogin(NOT_CONFIGURED);
    const invite = url.searchParams.get('invite') || '';
    const state = crypto.randomBytes(16).toString('base64url');
    const res = NextResponse.redirect(authorizeUrl(req, state));
    res.cookies.set('tt_oauth', JSON.stringify({ state, invite }), cookieOptions(req, 600));
    return res;
  }

  // Better Auth redirects failed callbacks back here (errorCallbackURL) with ?error=CODE.
  const error = url.searchParams.get('error');
  if (error) return toLogin(messageFor(error, url.searchParams.get('error_description') || ''));

  if (!googleEnabled()) return toLogin(NOT_CONFIGURED);
  const invite = (url.searchParams.get('invite') || '').slice(0, 100);
  try {
    const { headers, response } = await auth.api.signInSocial({
      body: {
        provider: 'google',
        callbackURL: `${origin}/`,
        errorCallbackURL: `${origin}/api/auth/google`,
        disableRedirect: true,
        // re-validated against the invitation (token + email) in the user.create hook
        ...(invite ? { additionalData: { invite } } : {}),
      },
      headers: req.headers,
      returnHeaders: true,
    });
    if (!response?.url) return toLogin(messageFor('', ''));
    const res = NextResponse.redirect(response.url);
    for (const cookie of headers.getSetCookie()) res.headers.append('set-cookie', cookie);
    return res;
  } catch (e) {
    console.error('[google]', e);
    return toLogin(messageFor('', ''));
  }
}
