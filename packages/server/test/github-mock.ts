// A stand-in for github.com and api.github.com (device flow and /user), so no test ever contacts GitHub.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface GitHubMock {
  url: string;
  /** Answers to the next access-token polls, in order; when empty: authorization_pending. */
  replies: Record<string, unknown>[];
  /** Access token -> the profile /user returns for it. */
  users: Record<string, { login: string; id: number }>;
  calls: { code: number; token: number; user: number };
  interval: number;
  close(): Promise<void>;
}

export async function startGitHubMock(): Promise<GitHubMock> {
  let n = 0;
  const mock = { replies: [], users: {}, calls: { code: 0, token: 0, user: 0 }, interval: 0.05 } as unknown as GitHubMock;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req); // drain the form body
    const reply = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/login/device/code") {
      mock.calls.code++;
      return reply({ device_code: `dev-${++n}`, user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: mock.interval, expires_in: 900 });
    }
    if (req.method === "POST" && req.url === "/login/oauth/access_token") {
      mock.calls.token++;
      return reply(mock.replies.shift() ?? { error: "authorization_pending" });
    }
    if (req.method === "GET" && req.url === "/user") {
      mock.calls.user++;
      const user = mock.users[(req.headers.authorization ?? "").replace(/^Bearer /, "")];
      return user ? reply(user) : reply({ message: "Bad credentials" }, 401);
    }
    reply({ message: "Not Found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return mock;
}
