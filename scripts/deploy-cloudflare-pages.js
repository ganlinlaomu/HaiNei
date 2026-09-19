const { spawnSync } = require("child_process");

const projectName = process.env.CF_PAGES_PROJECT_NAME || "hainei";
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const args = ["exec", "wrangler", "--", "pages", "deploy", "dist", "--project-name", projectName];

const result = spawnSync(npmCmd, args, { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
