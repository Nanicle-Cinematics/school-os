/**
 * The name of the session cookie, in ONE place.
 *
 * It was spelt out in three files (the session module, the light reader the crest and icon routes
 * use, and the account page that keeps the current session when it ends the others), and a rename
 * that missed one would have signed that path out without a single error. Plain, with no
 * `server-only`, so a verify script can import it rather than keep a fourth copy.
 *
 * ⚠️ NOT `__Host-` prefixed, deliberately; see "Sessions" in CLAUDE.md for why, and what it would cost.
 */
export const SESSION_COOKIE_NAME = "school_os_session";
