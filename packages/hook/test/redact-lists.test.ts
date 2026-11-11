// Round-2 bug hunt (#104 false negatives, #105 false positives), ported from lanes-bughunt/round2/red.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "../src/redact.ts";

const BENIGN = [
  "Fix the token refresh logic in auth.ts",
  "Add a password reset flow",
  "Rename tokenizer to lexer",
  "Implement getAccessToken: returns the cached token",
  "Update README: secret management section",
  "Refactor src/components/UserProfileSettingsPanel/UserProfileSettingsPanel.tsx",
  "Add test for api_key validation",
  "token: string should be optional in the config type",
  "Make the password field required, secret optional",
  "Why does tokenizer.ts: line 3 fail?",
  "Fix typo in https://github.com/acme/app/blob/main/docs/architecture/overview.md",
  "Add AuthTokenRefreshInterceptorMiddlewareFactoryForTheHttpClientLayer to the module list",
  "Fix path C:/Users/alice/Desktop/lanes/packages/hook/src/some/very/long/folder/structure/file.ts",
  "Bump dependency @types/node to 24.0.0 and update package-lock.json",
  "Add a unit test for the credential helper: it should reject empty input",
  "Handle the case where the secret key is missing: show an error",
  "Document how Bearer tokens are validated",
  "Add Basic auth example to docs",
  "Support --token flag in the cli",
  "Use sha256 of the file: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 in the test",
  "Fix commit 7497785abcdef1234567890abcdef1234567890a regression",
  "make sk-learn pipeline faster",
  "Rename pk_id to primaryKey and rk-tools",
  "Add secrets: section to the helm values",
  "Bypass the compass check, the pass count passed 3 times",
];

// [prompt, the secret that must not survive]
const SECRETS: [string, string][] = [
  ["use password hunter2 to log in", "hunter2"],
  ["the password is hunter2", "hunter2"],
  ["my password: hunter2xyz", "hunter2xyz"],
  ["set DB_PASSWORD=supersecret123 in .env", "supersecret123"],
  ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalr"],
  ["export STRIPE_KEY=sk_live_abcdefghijklmnopqrstuvwx", "abcdefghijkl"],
  ["curl -H 'Authorization: Bearer abc.def.ghi' https://x", "abc.def"],
  ["connect to postgres://admin:s3cr3t@db.example.com/prod", "s3cr3t"],
  ["use ghp_abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijkl"],
  ["token=abc123", "abc123"],
  ["TOKEN = 'abc 123'", "abc 123"],
  ["api key is abc123def456", "abc123def456"],
  ["the key is abc123def456ghi789", "abc123def456ghi789"],
  ["password hunter2", "hunter2"],
  ["login with user admin and pass hunter2", "hunter2"],
  ["pwd=hunter2", "hunter2"],
  ["pass: hunter2", "hunter2"],
  ["AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
  ["key=AIzaSyA-abcdefghijklmnopqrstuvwxyz12345", "AIza"],
  ["Authorization: Token abcdef123456", "abcdef123456"],
  ["x-api-key: abcdef123456", "abcdef123456"],
  ["mysql -u root -pS3cretPass", "S3cretPass"],
  ["client_secret: GOCSPX-abcdefghijklmnop", "GOCSPX"],
  ["the credentials are admin/hunter2", "hunter2"],
  ["use sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "abcdefghijkl"],
  ["SLACK_WEBHOOK=https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX", "T000"],
  ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijkl"],
  ["connection string Server=x;Password=hunter2;User Id=sa", "hunter2"],
  ['password="my pass phrase"', "pass phrase"],
  ["Use passphrase correct-horse-battery", "correct-horse"],
  ["ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7vbqajDhA user@host", "AAAAB3"],
  ["hunter2 is the password", "hunter2"],
  ["pw: hunter2", "hunter2"],
  ["bearer abcdef123456", "abcdef123456"],
  ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
];

test("ordinary task titles are left exactly as written (#105)", () => {
  for (const text of BENIGN) assert.equal(redactSecrets(text), text);
});

test("deterministic secret formats never survive in a title (#104)", () => {
  for (const [text, secret] of SECRETS) assert.ok(!redactSecrets(text).includes(secret), `leaked ${secret}: ${redactSecrets(text)}`);
});
