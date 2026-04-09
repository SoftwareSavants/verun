/**
 * Prompt sent to Claude when the user clicks "Auto-detect" for a project.
 * This creates a regular Verun task that analyzes the project and configures it
 * for parallel worktree development.
 *
 * Placeholders replaced at runtime:
 * - {REPO_PATH} — absolute path to the main repository
 * - {PROJECT_NAME} — the project's display name
 */
export const AUTODETECT_PROMPT = `Analyze this project and configure it for parallel development with Verun.

## Context

This project ("{PROJECT_NAME}") runs in isolated git worktrees. Each worktree is a separate copy of the repo where a different task runs in parallel. The main repo is at: {REPO_PATH}

Each task has these environment variables available:
- \`VERUN_PORT_0\` through \`VERUN_PORT_9\` — 10 unique ports allocated per task (no collisions between parallel tasks)
- \`VERUN_REPO_PATH\` — path to the main repository (useful for copying gitignored files)

## What to do

1. **Find gitignored config files** that need copying from the main repo into each worktree (e.g. \`.env\`, \`.env.local\`, secrets, credentials). List them.

2. **Detect all apps/services and their port configurations.** For monorepos, find each app that binds a port. Map each hardcoded port to a \`VERUN_PORT_*\` variable.

3. **Modify config files** to use \`VERUN_PORT_*\` env vars instead of hardcoded ports. For example:
   - In \`.env\` files: \`PORT=$VERUN_PORT_0\`
   - In \`package.json\` scripts: replace \`--port 3000\` with \`--port $VERUN_PORT_0\`
   - In config files: use env var references where the framework supports it
   - Create or update \`.env\` templates if needed

4. **Generate the Verun config** and save it as \`.verun.json\` in the worktree root.

   The config has two sections:

   **hooks** — shell commands for task lifecycle:
   - \`setup\`: runs after worktree creation (copy gitignored files, install deps)
   - \`destroy\`: runs before worktree deletion (usually empty)

   **startCommand** — auto-runs in terminal for each task (dev server command)

## IMPORTANT: Save config automatically

After analysis, you MUST write a \`.verun.json\` file in the root of the worktree with this exact structure:

\`\`\`json
{
  "hooks": {
    "setup": "cp \\"$VERUN_REPO_PATH/.env\\" .env && pnpm install",
    "destroy": ""
  },
  "startCommand": "pnpm dev"
}
\`\`\`

Replace the values with the actual config you determined. This file is automatically picked up by Verun and also serves as shared config for other contributors. Commit it to the repo.
`
