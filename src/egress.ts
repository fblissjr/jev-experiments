// What must never leave the machine inside a state, checked on the raw text
// before a request is built. Pure: the API key is passed in.
//
// This is a last line for credentials, not a privacy filter. Pattern scans
// fail open on free text (ccutils found paths, hosts and names that no
// pattern caught), so real sessions are not sent at all until an allowlist
// and the owner's per-run review exist. Only synthetic text is sent today.

/** Shapes of common credentials. A hit refuses the state. */
const CREDENTIAL_SHAPES: readonly [string, RegExp][] = [
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{10,}/],
  ['openai-style-key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['github-token', /\b(gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** Length of the slices of the loaded key that are searched for. */
export const KEY_SLICE = 16;

/**
 * Why a state must not be sent, or undefined when nothing was found. The
 * key check looks for the exact key, and for any slice of it, so a key cut
 * or wrapped inside the text is still caught.
 */
export function refuseState(state: unknown, apiKey: string | undefined): string | undefined {
  const text = JSON.stringify(state);
  if (apiKey && apiKey.length > 0) {
    if (text.includes(apiKey)) return 'holds-api-key';
    for (let at = 0; at + KEY_SLICE <= apiKey.length; at += 1) {
      if (text.includes(apiKey.slice(at, at + KEY_SLICE))) return 'holds-api-key';
    }
  }
  for (const [name, shape] of CREDENTIAL_SHAPES) if (shape.test(text)) return `credential:${name}`;
  return undefined;
}
