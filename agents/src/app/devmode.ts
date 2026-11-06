/**
 * Local development switches (the admin session, DevConsent, the World ID stand-in): only with
 * FACEVISA_LOCAL_DEV=1, never with NODE_ENV=production, never on mainnet. Checked on every use, not cached.
 */
export const localDevAllowed = (mode: string) => process.env.FACEVISA_LOCAL_DEV === "1" && process.env.NODE_ENV !== "production" && mode !== "mainnet";
