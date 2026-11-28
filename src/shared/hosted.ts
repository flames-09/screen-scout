/**
 * Baked-in relay URL, written by `node scripts/set-relay-url.mjs <url>`.
 *
 * Empty means "hosted mode is not configured in this build": the app stays in
 * Bring-Your-Own-Key mode and the hosted option is hidden everywhere. The E2E
 * suite overrides it at runtime with SCREEN_SCOUT_RELAY_URL.
 */
export const HOSTED_RELAY_URL = 'https://screen-scout-relay.flamesrise09.workers.dev'

/** Stable public model id sent to the relay; the relay maps it to a real model. */
export const HOSTED_PUBLIC_MODEL = 'scout-vision-1'

/**
 * Largest image (in encoded characters) the relay accepts. The worker caps the
 * whole JSON body at 6 MB; base64 inflates by ~4/3, so 4 MB of data URL stays
 * comfortably inside that limit.
 */
export const HOSTED_MAX_IMAGE_BYTES = 4 * 1024 * 1024

/**
 * Google OAuth client id for the desktop sign-in flow (loopback PKCE). This is
 * a PUBLIC identifier — it ships in the installer and appears in browser URLs;
 * the client secret lives only on the relay, which brokers the token exchange
 * and refresh calls. Empty disables Google sign-in.
 */
export const HOSTED_GOOGLE_CLIENT_ID = '446198339159-kn9re544of7digl6ke3gv9uk8pcblj2j.apps.googleusercontent.com'
