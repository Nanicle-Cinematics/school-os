/** Shared by the seed (which creates the logins) and the runner (which signs in as them). */
export const LOAD_PASSWORD = "LoadTest!2026";
/** Every email the seed makes ends `.load.test`: a reserved TLD, so nothing here can ever be mail to a real person. */
export const DOMAIN = "load.test";
/** Marks the sessions the runner mints, so it can remove exactly those and nothing else. */
export const SESSION_MARK = "load-test";
