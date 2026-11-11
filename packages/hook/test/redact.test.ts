import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "../src/hook.ts";

// Ported from the bug hunt (red.ts, issue #80): [prompt text, the secret that must not survive].
const CASES: [string, string][] = [
  ["export DB_PASSWORD=hunter2hunter2", "hunter2hunter2"],
  ["set AWS_SECRET_ACCESS_KEY=abcd1234 then deploy", "abcd1234"],
  ["STRIPE_SECRET=whsec_abcd then", "whsec_abcd"],
  ["use --password hunter2 for the login", "hunter2"],
  ["my password is hunter2", "hunter2"],
  ["Authorization: Bearer abc123def456", "abc123def456"],
  ["curl -H 'X-Api-Key: abc123def456ghi' https://x", "abc123def456ghi"],
  ["token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.sig", "eyJhbGciOiJIUzI1NiJ9"],
  ["token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.signaturepart", "signaturepart"],
  ["psql postgres://admin:s3cr3tP4ss@db.internal/app", "s3cr3tP4ss"],
  ["api_key: 'abc123'", "abc123"],
  ["GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqr"],
  ["client_secret=Zm9vYmFy", "Zm9vYmFy"],
  ["private key -----BEGIN RSA PRIVATE KEY----- MIIEow", "MIIEow"],
];

test("credential forms in a task title never survive redaction (#80)", () => {
  for (const [text, secret] of CASES) assert.ok(!redactSecrets(text).includes(secret), `leaked ${secret}: ${redactSecrets(text)}`);
});

test("ordinary prompts are left alone", () => {
  for (const text of ["Add a GET /health route in src/routes.ts", "rename the tokenizer module", "fix the login page layout"]) {
    assert.equal(redactSecrets(text), text);
  }
});
