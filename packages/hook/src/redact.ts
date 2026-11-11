// Removes things that look like credentials from text that leaves the machine (task titles become commit subjects,
// `Lanes-Task:` trailers and server task titles). Two failure modes matter equally (#80, #104, #105): a secret that
// survives, and an ordinary title that gets mangled. So every rule is targeted: a known token format, or a secret
// word followed by something that has the shape of a value (a digit, a symbol, inner capitals, a hyphenated phrase).
// shortcut: free text cannot be fully covered ("my secret is correct horse"); LANES_NO_PROMPT_TEXT=1 keeps titles out entirely.

const R = "[redacted]";
// Words that name a secret; they may sit inside an identifier (DB_PASSWORD, getAccessToken, x-api-key).
const LONG = "(?:password|passwd|passphrase|secret|token|api[_ -]?key|access[_-]?key|private[_-]?key|credentials?)";
const WORD = `(?:${LONG}|pass|pwd|pw)`;
// pass/pwd/pw only as whole words: "bypass", "compass" and "passed" are not secrets.
const NAME = String.raw`(?:[\w-]*${LONG}[\w-]*|\b(?:pass|pwd|pw)\b)`;
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;

/** A word that is only a value if it has a digit, a symbol, inner capitals or a hyphen: "hunter2", "GOCSPX-x", not "string". */
const shaped = (v: string) => /^["']|\d|[+/=@#$%^&*~_-]|.[A-Z]/.test(v);

export function redactSecrets(text: string): string {
  return (
    text
      .replace(/-----BEGIN [A-Z ]*-----.*/gs, R) // PEM: everything after the header
      .replace(/\b(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-\S+)\s+\S+/g, R) // public key lines
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, R) // JWTs, whole
      // Known token formats.
      .replace(/https:\/\/hooks\.slack\.com\/services\/\S+/g, R)
      .replace(/\bAIza[\w-]{35}\b/g, R)
      .replace(/\bGOCSPX-[\w-]{10,}/g, R)
      .replace(/\bnpm_[A-Za-z0-9]{30,}\b/g, R)
      .replace(/\b(sk|pk|rk)[-_](live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}/g, R)
      .replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{16,}/g, R)
      .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, R)
      // Authorization: <scheme> <anything>, and a bare "Bearer <value>" only when the value looks like one ("Bearer tokens" is prose).
      .replace(/\b(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)\S+/gi, `$1${R}`)
      .replace(/\b(Bearer|Basic)\s+([\w.~+/=-]{8,})/gi, (m, scheme: string, v: string) => (/[\d.~+/=_-]/.test(v) ? `${scheme} ${R}` : m))
      .replace(/\b(mysql|mysqldump|mariadb)\b([^\n]*?\s-p)\S+/g, `$1$2${R}`) // -pSECRET: no space, by design
      // NAME=value always; NAME: value only when it has the shape of a value ("token: string" is a type).
      .replace(new RegExp(String.raw`(${NAME})(\s*=\s*)${VALUE}`, "gi"), `$1$2${R}`)
      .replace(new RegExp(String.raw`(${NAME})(\s*:\s*)(${VALUE})`, "gi"), (m, name: string, sep: string, v: string) => (shaped(v) ? `${name}${sep}${R}` : m))
      // --password value (any value); --token value only if it looks like one ("--token flag" is prose).
      .replace(new RegExp(String.raw`(--?[\w-]*(?:password|passwd|passphrase|pass|pwd)[\w-]*\s+)\S+`, "gi"), `$1${R}`)
      .replace(new RegExp(String.raw`(--?${NAME}\s+)(\S+)`, "gi"), (m, flag: string, v: string) => (shaped(v) ? `${flag}${R}` : m))
      // "my password is hunter2", "api key is abc123", "the key is abc123def" (a bare "key" needs a shaped value).
      .replace(new RegExp(String.raw`(\b${WORD}\s+is\s+)\S+`, "gi"), `$1${R}`)
      .replace(/(\bkey\s+is\s+)(\S+)/gi, (m, pre: string, v: string) => (shaped(v) ? `${pre}${R}` : m))
      .replace(/(\bcredentials?\s+(?:are|is)\s+)\S+/gi, `$1${R}`)
      .replace(new RegExp(String.raw`(\S+)(\s+is\s+the\s+(?:password|passphrase|secret|token|key)\b)`, "gi"), (m, v: string, rest: string) => (shaped(v) ? `${R}${rest}` : m))
      // "password hunter2", "login with pass hunter2", "passphrase correct-horse-battery": the value must be shaped.
      .replace(new RegExp(String.raw`(\b(?:password|passwd|passphrase|pass|pwd|pw)\s+)(\S{4,})`, "gi"), (m, pre: string, v: string) => (shaped(v) ? `${pre}${R}` : m))
      .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, `://${R}@`)
      // Long opaque strings: letters and digits mixed, no path separators, and not a git/sha256 hash.
      .replace(/\b[A-Za-z0-9+_-]{40,}\b/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(m) ? R : m))
  );
}
