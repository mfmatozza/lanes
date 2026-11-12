// Runs every package's tests with one test file per spare core, at most 8: git-heavy integration tests time out when
// more run at once than the machine has cores (19 on a 20-core laptop, while a 4-core CI runner gets 3).
import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";

const n = Math.max(1, Math.min(8, availableParallelism() - 1));
const r = spawnSync(process.execPath, ["--test", `--test-concurrency=${n}`, "packages/*/test/**/*.test.ts", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
