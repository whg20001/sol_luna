import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Fail closed in CI: missing Pi peers must not turn integration tests into skips.
const result = spawnSync(process.execPath, ["--test", "tests/pi-adapter.test.js"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: { ...process.env, SOL_LUNA_REQUIRE_PI_PEERS: "1" },
  stdio: "inherit",
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
