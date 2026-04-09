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

This project runs in isolated git worktrees. Each worktree is a separate copy of the repo where a different task runs in parallel. The main repo is at: {REPO_PATH}

Each task has these environment variables available:
- \`VERUN_PORT_0\` through \`VERUN_PORT_9\` — 10 unique ports allocated per task (no collisions between parallel tasks)
- \`VERUN_REPO_PATH\` — path to the main repository

## Steps

### 1. Find gitignored files that need copying between worktrees

Search \`.gitignore\` files (root and nested) for ignored config/secret patterns (\`.env*\`, \`.dev.vars\`, \`*.pem\`, credentials). Check which of these files actually exist in the main repo. **If none exist, look for \`.env.example\` files that should be copied as \`.env\` as a fallback.**

### 2. Detect ALL apps/services and their port configurations

Find every app/service that binds a network port. Check:
- \`package.json\` \`dev\`/\`start\` scripts for \`--port\` flags
- Framework config files (next.config.*, wrangler.toml/json, vite.config.*, etc.)
- \`.env\`/\`.env.example\` files for \`PORT=\`, \`*_URL=http://localhost:*\` patterns
- Orchestrator configs (turbo.json, nx.json, etc.) for port env vars
- Any source file that reads a \`PORT\` or \`*_PORT\` env var (e.g. \`process.env.SERVER_PORT\`)

**Map every service to a \`VERUN_PORT_*\` slot. Don't skip any service — including docs sites, mobile bundlers, etc.**

### 3. Modify config files

For each service, make its port configurable via a descriptive env var (e.g. \`WEB_PORT\`, \`SERVER_PORT\`, \`DOCS_PORT\`, \`NATIVE_PORT\`) with the current hardcoded port as default:
- In dev scripts: \`--port \${WEB_PORT:-3001}\`
- In config files: \`process.env.PORT || 3000\`
- **If using a monorepo orchestrator (turbo, nx), add all port env vars to its passthrough/env config so they reach each app's dev process.**

For \`.env\` files that contain inter-service URLs (e.g. \`NEXT_PUBLIC_SERVER_URL=http://localhost:3000\`, \`CORS_ORIGIN=http://localhost:3001\`), these will be rewritten by the setup hook using \`sed\` after copying.

### 4. Generate \`.verun.json\`

Write \`.verun.json\` to the worktree root with this structure:

\`\`\`json
{
  "hooks": {
    "setup": "<copy gitignored files from $VERUN_REPO_PATH, falling back to .env.example → .env if no .env exists; rewrite localhost port references in copied .env files using sed to match allocated VERUN_PORT_* values; install deps>",
    "destroy": "<copy .env files back to $VERUN_REPO_PATH so env var updates made during the task aren't lost>"
  },
  "startCommand": "<set all port env vars from VERUN_PORT_* slots, then run the dev command>"
}
\`\`\`

**Setup hook must:**
- Copy \`.env\` from main repo if it exists, else copy \`.env.example\` as \`.env\`
- \`sed\`-replace \`http://localhost:NNNN\` patterns in copied env files to use allocated ports
- Run dependency install

**Destroy hook must:**
- Copy env files back to main repo to preserve any changes made during the task

**startCommand must:**
- Set every port env var mapped in step 2 (e.g. \`SERVER_PORT=$VERUN_PORT_0 WEB_PORT=$VERUN_PORT_1 ... pnpm dev\`)
`
