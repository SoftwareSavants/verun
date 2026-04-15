/**
 * Demo seed data for VITE_DEMO_MODE=true.
 * Used for screenshots / marketing materials.
 * Not included in production builds (tree-shaken when the env var is absent).
 */

import type { Project, Task, Session, OutputLine, GitStatus, BranchCommit, PrInfo, CiCheck, GitHubRepo, Problem } from '../types'

const T = 1744617600000 // 2025-04-14 00:00:00 UTC
const Ts = T / 1000     // seconds

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const DEMO_PROJECTS: Project[] = [
  {
    id: 'demo-proj-verun',
    name: 'verun',
    repoPath: '/Users/dev/verun',
    baseBranch: 'main',
    setupHook: 'pnpm install',
    destroyHook: '',
    startCommand: 'pnpm tauri dev',
    autoStart: false,
    createdAt: T - 30 * 24 * 3_600_000,
    defaultAgentType: 'claude',
  },
  {
    id: 'demo-proj-dashboard',
    name: 'dashboard',
    repoPath: '/Users/dev/dashboard',
    baseBranch: 'main',
    setupHook: '',
    destroyHook: '',
    startCommand: 'pnpm dev',
    autoStart: false,
    createdAt: T - 20 * 24 * 3_600_000,
    defaultAgentType: 'claude',
  },
  {
    id: 'demo-proj-api',
    name: 'api-server',
    repoPath: '/Users/dev/api-server',
    baseBranch: 'main',
    setupHook: '',
    destroyHook: '',
    startCommand: 'cargo run',
    autoStart: false,
    createdAt: T - 10 * 24 * 3_600_000,
    defaultAgentType: 'claude',
  },
]

// ---------------------------------------------------------------------------
// Tasks — all 7 phases covered
// ---------------------------------------------------------------------------

export const DEMO_TASKS: Task[] = [
  // ── verun ─────────────────────────────────────────────────────────────────
  {
    id: 'demo-task-md',
    projectId: 'demo-proj-verun',
    name: 'Fix markdown rendering',
    worktreePath: '/Users/dev/verun/.verun/worktrees/fix-markdown',
    branch: 'fix/markdown-syntax-highlighting',
    createdAt: T - 2 * 3_600_000,
    mergeBaseSha: 'a1b2c3d',
    portOffset: 0,
    archived: false,
    archivedAt: null,
    lastCommitMessage: null,
    parentTaskId: null,
    agentType: 'claude',
  },
  {
    id: 'demo-task-ctx',
    projectId: 'demo-proj-verun',
    name: 'Context menu refactor',
    worktreePath: '/Users/dev/verun/.verun/worktrees/ctx-menu',
    branch: 'refactor/context-menu',
    createdAt: T - 5 * 3_600_000,
    mergeBaseSha: 'd4e5f6a',
    portOffset: 1,
    archived: false,
    archivedAt: null,
    lastCommitMessage: 'refactor: extract ContextMenu into shared component',
    parentTaskId: null,
    agentType: 'claude',
  },
  {
    id: 'demo-task-diff',
    projectId: 'demo-proj-verun',
    name: 'Code folding in diffs',
    worktreePath: '/Users/dev/verun/.verun/worktrees/diff-fold',
    branch: 'feat/diff-code-folding',
    createdAt: T - 8 * 3_600_000,
    mergeBaseSha: 'b7c8d9e',
    portOffset: 2,
    archived: false,
    archivedAt: null,
    lastCommitMessage: null,
    parentTaskId: null,
    agentType: 'claude',
  },
  // phase: pr-open
  {
    id: 'demo-task-pr',
    projectId: 'demo-proj-verun',
    name: 'Add file tree panel',
    worktreePath: '/Users/dev/verun/.verun/worktrees/file-tree',
    branch: 'feat/file-tree-panel',
    createdAt: T - 12 * 3_600_000,
    mergeBaseSha: 'f1e2d3c',
    portOffset: 3,
    archived: false,
    archivedAt: null,
    lastCommitMessage: 'feat: render file tree in right panel',
    parentTaskId: null,
    agentType: 'claude',
  },
  // phase: ci-failed
  {
    id: 'demo-task-ci',
    projectId: 'demo-proj-verun',
    name: 'Optimize startup time',
    worktreePath: '/Users/dev/verun/.verun/worktrees/startup-perf',
    branch: 'perf/faster-startup',
    createdAt: T - 16 * 3_600_000,
    mergeBaseSha: 'c4b5a6f',
    portOffset: 4,
    archived: false,
    archivedAt: null,
    lastCommitMessage: 'perf: lazy-load heavy modules on first use',
    parentTaskId: null,
    agentType: 'claude',
  },
  // ── dashboard ─────────────────────────────────────────────────────────────
  {
    id: 'demo-task-dark',
    projectId: 'demo-proj-dashboard',
    name: 'Dark mode support',
    worktreePath: '/Users/dev/dashboard/.verun/worktrees/dark-mode',
    branch: 'feat/dark-mode',
    createdAt: T - 3 * 3_600_000,
    mergeBaseSha: null,
    portOffset: 0,
    archived: false,
    archivedAt: null,
    lastCommitMessage: null,
    parentTaskId: null,
    agentType: 'claude',
  },
  {
    id: 'demo-task-perf',
    projectId: 'demo-proj-dashboard',
    name: 'Bundle size audit',
    worktreePath: '/Users/dev/dashboard/.verun/worktrees/bundle-size',
    branch: 'fix/reduce-bundle-size',
    createdAt: T - 6 * 3_600_000,
    mergeBaseSha: null,
    portOffset: 1,
    archived: false,
    archivedAt: null,
    lastCommitMessage: 'chore: replace moment.js with date-fns',
    parentTaskId: null,
    agentType: 'claude',
  },
  // phase: conflicts
  {
    id: 'demo-task-conflict',
    projectId: 'demo-proj-dashboard',
    name: 'Migrate config format',
    worktreePath: '/Users/dev/dashboard/.verun/worktrees/config-migrate',
    branch: 'chore/migrate-config-format',
    createdAt: T - 24 * 3_600_000,
    mergeBaseSha: '9a8b7c6',
    portOffset: 2,
    archived: false,
    archivedAt: null,
    lastCommitMessage: 'chore: convert JSON configs to TOML',
    parentTaskId: null,
    agentType: 'claude',
  },
  // phase: pr-merged
  {
    id: 'demo-task-merged',
    projectId: 'demo-proj-dashboard',
    name: 'Add data export',
    worktreePath: '/Users/dev/dashboard/.verun/worktrees/data-export',
    branch: 'feat/csv-export',
    createdAt: T - 48 * 3_600_000,
    mergeBaseSha: '1f2e3d4',
    portOffset: 3,
    archived: false,
    archivedAt: null,
    lastCommitMessage: 'feat: export table data to CSV',
    parentTaskId: null,
    agentType: 'claude',
  },
  // ── api-server ────────────────────────────────────────────────────────────
  {
    id: 'demo-task-jwt',
    projectId: 'demo-proj-api',
    name: 'JWT refresh tokens',
    worktreePath: '/Users/dev/api-server/.verun/worktrees/jwt-refresh',
    branch: 'feat/jwt-refresh',
    createdAt: T - 4 * 3_600_000,
    mergeBaseSha: null,
    portOffset: 0,
    archived: false,
    archivedAt: null,
    lastCommitMessage: 'feat: implement /auth/refresh endpoint',
    parentTaskId: null,
    agentType: 'claude',
  },
  {
    id: 'demo-task-rate',
    projectId: 'demo-proj-api',
    name: 'Rate limiting middleware',
    worktreePath: '/Users/dev/api-server/.verun/worktrees/rate-limit',
    branch: 'feat/rate-limiting',
    createdAt: T - 1 * 3_600_000,
    mergeBaseSha: null,
    portOffset: 1,
    archived: false,
    archivedAt: null,
    lastCommitMessage: null,
    parentTaskId: null,
    agentType: 'claude',
  },
  // phase: error
  {
    id: 'demo-task-err',
    projectId: 'demo-proj-api',
    name: 'Fix WebSocket reconnect',
    worktreePath: '/Users/dev/api-server/.verun/worktrees/ws-reconnect',
    branch: 'fix/websocket-reconnect',
    createdAt: T - 7 * 3_600_000,
    mergeBaseSha: null,
    portOffset: 2,
    archived: false,
    archivedAt: null,
    lastCommitMessage: null,
    parentTaskId: null,
    agentType: 'claude',
  },
]

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const DEMO_SESSIONS: Session[] = [
  // demo-task-md (selected, 2 sessions)
  {
    id: 'demo-sess-md-1',
    taskId: 'demo-task-md',
    name: 'Session 1',
    resumeSessionId: 'cs-demo-001',
    status: 'idle',
    startedAt: T - 2 * 3_600_000,
    endedAt: T - 30 * 60_000,
    totalCost: 0.045,
    parentSessionId: null,
    forkedAtMessageUuid: null,
    agentType: 'claude',
    model: null,
  },
  {
    id: 'demo-sess-md-2',
    taskId: 'demo-task-md',
    name: 'Session 2',
    resumeSessionId: 'cs-demo-002',
    status: 'idle',
    startedAt: T - 25 * 60_000,
    endedAt: T - 10 * 60_000,
    totalCost: 0.009,
    parentSessionId: null,
    forkedAtMessageUuid: null,
    agentType: 'claude',
    model: null,
  },
  // other tasks
  { id: 'demo-sess-ctx-1',      taskId: 'demo-task-ctx',      name: null, resumeSessionId: null, status: 'running', startedAt: T - 5  * 3_600_000, endedAt: null, totalCost: 0.021, parentSessionId: null, forkedAtMessageUuid: null, agentType: 'claude', model: null },
  { id: 'demo-sess-diff-1',     taskId: 'demo-task-diff',     name: null, resumeSessionId: null, status: 'running', startedAt: T - 18 * 60_000,    endedAt: null, totalCost: 0.007, parentSessionId: null, forkedAtMessageUuid: null, agentType: 'claude', model: null },
  { id: 'demo-sess-pr-1',       taskId: 'demo-task-pr',       name: null, resumeSessionId: null, status: 'idle',    startedAt: T - 12 * 3_600_000, endedAt: null, totalCost: 0.052, parentSessionId: null, forkedAtMessageUuid: null, agentType: 'claude', model: null },
  { id: 'demo-sess-ci-1',       taskId: 'demo-task-ci',       name: null, resumeSessionId: null, status: 'idle',    startedAt: T - 16 * 3_600_000, endedAt: null, totalCost: 0.038, parentSessionId: null, forkedAtMessageUuid: null, agentType: 'claude', model: null },
  { id: 'demo-sess-dark-1',     taskId: 'demo-task-dark',     name: null, resumeSessionId: null, status: 'running', startedAt: T - 3  * 3_600_000, endedAt: null, totalCost: 0,     parentSessionId: null, forkedAtMessageUuid: null, agentType: 'claude', model: null },
  { id: 'demo-sess-perf-1',     taskId: 'demo-task-perf',     name: null, resumeSessionId: null, status: 'idle',    startedAt: T - 6  * 3_600_000, endedAt: null, totalCost: 0.033, parentSessionId: null, forkedAtMessageUuid: null, agentType: 'claude', model: null },
  { id: 'demo-sess-conflict-1', taskId: 'demo-task-conflict', name: null, resumeSessionId: null, status: 'idle',    startedAt: T - 24 * 3_600_000, endedAt: null, totalCost: 0.041, parentSessionId: null, forkedAtMessageUuid: null, agentType: 'claude', model: null },
  { id: 'demo-sess-merged-1',   taskId: 'demo-task-merged',   name: null, resumeSessionId: null, status: 'idle',    startedAt: T - 48 * 3_600_000, endedAt: null, totalCost: 0.067, parentSessionId: null, forkedAtMessageUuid: null, agentType: 'claude', model: null },
  { id: 'demo-sess-jwt-1',      taskId: 'demo-task-jwt',      name: null, resumeSessionId: null, status: 'idle',    startedAt: T - 4  * 3_600_000, endedAt: null, totalCost: 0.018, parentSessionId: null, forkedAtMessageUuid: null, agentType: 'claude', model: null },
  { id: 'demo-sess-rate-1',     taskId: 'demo-task-rate',     name: null, resumeSessionId: null, status: 'running', startedAt: T - 1  * 3_600_000, endedAt: null, totalCost: 0,     parentSessionId: null, forkedAtMessageUuid: null, agentType: 'claude', model: null },
  { id: 'demo-sess-err-1',      taskId: 'demo-task-err',      name: null, resumeSessionId: null, status: 'error',   startedAt: T - 7  * 3_600_000, endedAt: null, totalCost: 0.011, parentSessionId: null, forkedAtMessageUuid: null, agentType: 'claude', model: null },
]

// ---------------------------------------------------------------------------
// Git data — returned by mocked IPC functions
// ---------------------------------------------------------------------------

const VERUN_REPO: GitHubRepo  = { owner: 'SoftwareSavants', name: 'verun',      url: 'https://github.com/SoftwareSavants/verun' }
const DASH_REPO: GitHubRepo   = { owner: 'SoftwareSavants', name: 'dashboard',   url: 'https://github.com/SoftwareSavants/dashboard' }
const API_REPO: GitHubRepo    = { owner: 'SoftwareSavants', name: 'api-server',  url: 'https://github.com/SoftwareSavants/api-server' }

function gitStatus(files: Array<{ path: string; status: string; ins: number; del: number }>): GitStatus {
  return {
    files: files.map(f => ({ path: f.path, status: f.status, staging: '' })),
    stats: files.map(f => ({ path: f.path, insertions: f.ins, deletions: f.del })),
    totalInsertions: files.reduce((s, f) => s + f.ins, 0),
    totalDeletions:  files.reduce((s, f) => s + f.del, 0),
  }
}

function commit(shortHash: string, message: string, author: string, hoursAgo: number, files: number, ins: number, del: number): BranchCommit {
  return {
    hash: shortHash.padEnd(40, '0'),
    shortHash,
    message,
    author,
    timestamp: Ts - hoursAgo * 3600,
    filesChanged: files,
    insertions: ins,
    deletions: del,
  }
}

function ci(name: string, status: string): CiCheck {
  return { name, status, url: 'https://github.com/SoftwareSavants/verun/actions' }
}

interface DemoGitEntry {
  status: GitStatus
  commits: BranchCommit[]
  branchStatus: [number, number, number]  // [ahead, behind, unpushed]
  pr: PrInfo | null
  checks: CiCheck[]
  branchUrl: string | null
  github: GitHubRepo | null
}

export const DEMO_GIT_DATA: Record<string, DemoGitEntry> = {

  // idle — selected task, shows file changes in Changes panel
  'demo-task-md': {
    status: gitStatus([
      { path: 'src/components/ChatView.tsx', status: 'M', ins: 45, del: 12 },
      { path: 'src/styles/code.css',         status: 'A', ins: 28, del: 0  },
      { path: 'src/lib/markdown.ts',         status: 'A', ins: 62, del: 0  },
    ]),
    commits: [
      commit('a1b2c3d', 'fix: configure marked-highlight for syntax highlighting', 'Abdulrahman', 1, 3, 87, 8),
      commit('e4f5a6b', 'chore: add highlight.js and marked-highlight deps',       'Abdulrahman', 2, 1, 3,  0),
    ],
    branchStatus: [2, 0, 2],
    pr: null,
    checks: [],
    branchUrl: 'https://github.com/SoftwareSavants/verun/tree/fix/markdown-syntax-highlighting',
    github: VERUN_REPO,
  },

  // idle — some local commits, not pushed yet
  'demo-task-ctx': {
    status: gitStatus([
      { path: 'src/components/ContextMenu.tsx', status: 'M', ins: 18, del: 34 },
    ]),
    commits: [
      commit('d4e5f6a', 'refactor: extract ContextMenu into shared component', 'Abdulrahman', 4, 4, 112, 89),
    ],
    branchStatus: [1, 0, 1],
    pr: null,
    checks: [],
    branchUrl: 'https://github.com/SoftwareSavants/verun/tree/refactor/context-menu',
    github: VERUN_REPO,
  },

  // running — no commits yet, working tree dirty
  'demo-task-diff': {
    status: gitStatus([
      { path: 'src/components/FileDiff.tsx', status: 'M', ins: 23, del: 5 },
      { path: 'src/components/DiffHunk.tsx', status: 'M', ins: 11, del: 2 },
    ]),
    commits: [],
    branchStatus: [0, 0, 0],
    pr: null,
    checks: [],
    branchUrl: null,
    github: VERUN_REPO,
  },

  // pr-open — clean tree, PR open, CI passing + one in-progress
  'demo-task-pr': {
    status: gitStatus([]),
    commits: [
      commit('f1e2d3c', 'feat: render file tree in right panel',            'Abdulrahman', 8,  5, 203, 12),
      commit('a9b8c7d', 'feat: add FileTree component with expand/collapse', 'Abdulrahman', 10, 3, 148, 0 ),
      commit('e6f5a4b', 'chore: add file-tree types',                        'Abdulrahman', 11, 1, 24,  0 ),
    ],
    branchStatus: [3, 0, 0],
    pr: { number: 47, url: 'https://github.com/SoftwareSavants/verun/pull/47', state: 'OPEN', title: 'Add file tree panel', mergeable: 'MERGEABLE', isDraft: false },
    checks: [
      ci('CI / test',  'SUCCESS'),
      ci('CI / lint',  'SUCCESS'),
      ci('CI / build', 'IN_PROGRESS'),
    ],
    branchUrl: 'https://github.com/SoftwareSavants/verun/tree/feat/file-tree-panel',
    github: VERUN_REPO,
  },

  // ci-failed — PR open, test suite failing
  'demo-task-ci': {
    status: gitStatus([]),
    commits: [
      commit('c4b5a6f', 'perf: lazy-load heavy modules on first use', 'Abdulrahman', 14, 6, 89, 42),
      commit('b3a2f1e', 'perf: defer xterm.js init until tab focus',   'Abdulrahman', 15, 2, 31, 8 ),
    ],
    branchStatus: [2, 0, 0],
    pr: { number: 45, url: 'https://github.com/SoftwareSavants/verun/pull/45', state: 'OPEN', title: 'Optimize startup time', mergeable: 'MERGEABLE', isDraft: false },
    checks: [
      ci('CI / test',  'FAILURE'),
      ci('CI / lint',  'SUCCESS'),
      ci('CI / build', 'SUCCESS'),
    ],
    branchUrl: 'https://github.com/SoftwareSavants/verun/tree/perf/faster-startup',
    github: VERUN_REPO,
  },

  // idle — dashboard tasks
  'demo-task-dark': {
    status: gitStatus([
      { path: 'src/styles/theme.css',         status: 'M', ins: 54, del: 12 },
      { path: 'src/components/ThemeToggle.tsx', status: 'A', ins: 38, del: 0  },
    ]),
    commits: [],
    branchStatus: [0, 0, 0],
    pr: null,
    checks: [],
    branchUrl: null,
    github: DASH_REPO,
  },

  'demo-task-perf': {
    status: gitStatus([]),
    commits: [
      commit('7a8b9c0', 'chore: replace moment.js with date-fns',     'Abdulrahman', 5, 8, 23, 412),
      commit('1d2e3f4', 'chore: tree-shake lodash with babel plugin',  'Abdulrahman', 6, 3, 8,  62 ),
    ],
    branchStatus: [2, 0, 1],
    pr: null,
    checks: [],
    branchUrl: 'https://github.com/SoftwareSavants/dashboard/tree/fix/reduce-bundle-size',
    github: DASH_REPO,
  },

  // conflicts — behind main, CONFLICTING
  'demo-task-conflict': {
    status: gitStatus([]),
    commits: [
      commit('9a8b7c6', 'chore: convert JSON configs to TOML',        'Abdulrahman', 20, 12, 340, 280),
      commit('5f4e3d2', 'chore: add TOML parser dependency',           'Abdulrahman', 21, 2,  6,   0  ),
      commit('c1b0a9f', 'chore: update config loading in main entry',  'Abdulrahman', 22, 3,  45,  67 ),
      commit('8e7d6c5', 'chore: migrate CI config to TOML',            'Abdulrahman', 23, 1,  28,  31 ),
    ],
    branchStatus: [4, 3, 0],
    pr: { number: 12, url: 'https://github.com/SoftwareSavants/dashboard/pull/12', state: 'OPEN', title: 'Migrate config format to TOML', mergeable: 'CONFLICTING', isDraft: false },
    checks: [
      ci('CI / test', 'SUCCESS'),
      ci('CI / lint', 'SUCCESS'),
    ],
    branchUrl: 'https://github.com/SoftwareSavants/dashboard/tree/chore/migrate-config-format',
    github: DASH_REPO,
  },

  // pr-merged
  'demo-task-merged': {
    status: gitStatus([]),
    commits: [
      commit('1f2e3d4', 'feat: export table data to CSV',             'Abdulrahman', 46, 4, 112, 0 ),
      commit('5a6b7c8', 'feat: add column selector for export',        'Abdulrahman', 47, 2, 58,  0 ),
      commit('9d0e1f2', 'feat: stream large exports to avoid OOM',     'Abdulrahman', 47, 3, 74,  0 ),
      commit('3a4b5c6', 'test: add CSV export integration tests',      'Abdulrahman', 47, 1, 89,  0 ),
      commit('7d8e9f0', 'chore: add fast-csv dependency',              'Abdulrahman', 48, 1, 3,   0 ),
    ],
    branchStatus: [0, 0, 0],
    pr: { number: 11, url: 'https://github.com/SoftwareSavants/dashboard/pull/11', state: 'MERGED', title: 'Add data export to CSV', mergeable: 'MERGEABLE', isDraft: false },
    checks: [
      ci('CI / test',  'SUCCESS'),
      ci('CI / lint',  'SUCCESS'),
      ci('CI / build', 'SUCCESS'),
    ],
    branchUrl: 'https://github.com/SoftwareSavants/dashboard/tree/feat/csv-export',
    github: DASH_REPO,
  },

  // idle — api-server
  'demo-task-jwt': {
    status: gitStatus([
      { path: 'src/auth/refresh.rs',  status: 'M', ins: 67, del: 4 },
      { path: 'src/auth/tokens.rs',   status: 'M', ins: 22, del: 8 },
      { path: 'src/routes/auth.rs',   status: 'M', ins: 15, del: 3 },
    ]),
    commits: [
      commit('a1b3c5d', 'feat: implement /auth/refresh endpoint', 'Abdulrahman', 3, 3, 67, 4),
    ],
    branchStatus: [1, 0, 1],
    pr: null,
    checks: [],
    branchUrl: null,
    github: API_REPO,
  },

  'demo-task-rate': {
    status: gitStatus([
      { path: 'src/middleware/rate_limit.rs', status: 'A', ins: 134, del: 0 },
    ]),
    commits: [],
    branchStatus: [0, 0, 0],
    pr: null,
    checks: [],
    branchUrl: null,
    github: API_REPO,
  },

  // error — session errored mid-run
  'demo-task-err': {
    status: gitStatus([
      { path: 'src/ws/reconnect.rs', status: 'M', ins: 9, del: 3 },
    ]),
    commits: [],
    branchStatus: [0, 0, 0],
    pr: null,
    checks: [],
    branchUrl: null,
    github: API_REPO,
  },
}

// ---------------------------------------------------------------------------
// Problems — LSP diagnostics for the Problems panel
// ---------------------------------------------------------------------------

function prob(file: string, line: number, col: number, endLine: number, endCol: number, severity: Problem['severity'], message: string, code: string): Problem {
  return { file, line, column: col, endLine, endColumn: endCol, severity, message, code, source: 'typescript' }
}

// taskId → relativePath → Problem[]
export const DEMO_PROBLEMS: Record<string, Record<string, Problem[]>> = {
  'demo-task-md': {
    'src/components/ChatView.tsx': [
      prob('src/components/ChatView.tsx',  47, 5,  47, 42,  'error',   "Type 'string | Promise<string>' is not assignable to type 'string'.",                    'TS2322'),
      prob('src/components/ChatView.tsx',  61, 15, 61, 23,  'warning', "Parameter 'lang' is declared but its value is never read.",                               'TS6133'),
    ],
    'src/lib/markdown.ts': [
      prob('src/lib/markdown.ts',          12, 3,  12, 38,  'error',   "Property 'highlight' does not exist on type 'MarkedOptions'.",                            'TS2339'),
      prob('src/lib/markdown.ts',          28, 18, 28, 26,  'error',   "Object is possibly 'undefined'.",                                                         'TS2532'),
      prob('src/lib/markdown.ts',          34, 7,  34, 19,  'warning', "Variable 'sanitized' is assigned a value but never used.",                                'TS6133'),
    ],
  },
  'demo-task-ci': {
    'src/startup.ts': [
      prob('src/startup.ts',               23, 5,  23, 29,  'error',   "Argument of type 'string | undefined' is not assignable to parameter of type 'string'.", 'TS2345'),
    ],
    'src/components/SplashScreen.tsx': [
      prob('src/components/SplashScreen.tsx', 8, 1, 8, 31,  'warning', "'React' is defined but never used.",                                                      'TS6133'),
    ],
  },
  'demo-task-err': {
    'src/ws/reconnect.rs': [
      prob('src/ws/reconnect.rs',           14, 9,  14, 45,  'error',   "unused variable: `backoff_ms`",                                                          'dead_code'),
    ],
  },
}

// ---------------------------------------------------------------------------
// Output lines — NDJSON formatted for parseNdjsonLine()
// ---------------------------------------------------------------------------

function line(id: number, sessionId: string, obj: object, emittedAt: number): OutputLine {
  return { id, sessionId, line: JSON.stringify(obj), emittedAt }
}

const userMsg = (id: number, sid: string, text: string, t: number): OutputLine =>
  line(id, sid, { type: 'verun_user_message', text }, t)

const thinkDelta = (id: number, sid: string, thinking: string, t: number): OutputLine =>
  line(id, sid, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking } } }, t)

const textDelta = (id: number, sid: string, text: string, t: number): OutputLine =>
  line(id, sid, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }, t)

const toolStart = (id: number, sid: string, name: string, input: object, t: number): OutputLine =>
  line(id, sid, { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name, input } } }, t)

const toolResult = (id: number, sid: string, content: string, isError: boolean, t: number): OutputLine =>
  line(id, sid, { type: 'user', message: { content: [{ type: 'tool_result', content, is_error: isError }] } }, t)

const turnEnd = (id: number, sid: string, cost: number, inputTokens: number, outputTokens: number, t: number): OutputLine =>
  line(id, sid, { type: 'result', subtype: 'success', total_cost_usd: cost, usage: { input_tokens: inputTokens, output_tokens: outputTokens } }, t)

// Session 1 — full conversation
const S1 = 'demo-sess-md-1'
const T1 = T - 2 * 3_600_000

const SESSION1_LINES: OutputLine[] = [
  // ---- Turn 1 ----
  userMsg(1, S1,
    "The code blocks in the chat view aren't rendering with syntax highlighting — " +
    "Claude's code responses just show as plain text. Can you track down and fix this?",
    T1),

  thinkDelta(2, S1,
    "The user wants syntax highlighting in code blocks in ChatView. I should look at " +
    "how markdown is rendered — what library is used and whether highlight.js is wired up. " +
    "Let me check ChatView and package.json.",
    T1 + 2_000),

  textDelta(3, S1, "I'll track down the markdown rendering issue. Let me check the current ChatView implementation first.", T1 + 6_000),

  toolStart(4, S1, 'Read', { file_path: 'src/components/ChatView.tsx' }, T1 + 9_000),

  toolResult(5, S1,
    "src/components/ChatView.tsx\n\n" +
    "import { marked } from 'marked'\n\n" +
    "function renderMarkdown(text: string): string {\n" +
    "  // TODO: wire up syntax highlighter\n" +
    "  return marked.parse(text) as string\n" +
    "}\n\n" +
    "// Code blocks render as plain <code> without hljs classes",
    false, T1 + 10_000),

  textDelta(6, S1, "\n\nFound it — `marked` is set up but no highlighter is configured. Let me check `package.json` to see if `highlight.js` is already installed.", T1 + 14_000),

  toolStart(7, S1, 'Read', { file_path: 'package.json' }, T1 + 16_000),

  toolResult(8, S1,
    '{\n  "dependencies": {\n' +
    '    "highlight.js": "^11.9.0",\n' +
    '    "marked": "^12.0.0",\n' +
    '    "marked-highlight": "^2.1.1"\n' +
    '  }\n}',
    false, T1 + 17_000),

  textDelta(9, S1, "\n\n`highlight.js` and `marked-highlight` are already installed — just not wired up. Fixing now.", T1 + 20_000),

  toolStart(10, S1, 'Edit', { file_path: 'src/components/ChatView.tsx' }, T1 + 22_000),

  toolResult(11, S1, "The file has been updated successfully.", false, T1 + 24_000),

  textDelta(12, S1,
    "\n\nSyntax highlighting is now configured in `ChatView.tsx`:\n\n" +
    "```typescript\nimport { marked } from 'marked'\n" +
    "import { markedHighlight } from 'marked-highlight'\n" +
    "import hljs from 'highlight.js'\n\n" +
    "marked.use(markedHighlight({\n" +
    "  langPrefix: 'hljs language-',\n" +
    "  highlight(code, lang) {\n" +
    "    const language = hljs.getLanguage(lang) ? lang : 'plaintext'\n" +
    "    return hljs.highlight(code, { language }).value\n" +
    "  },\n" +
    "}))\n```\n\n" +
    "Code blocks now render with proper syntax highlighting for TypeScript, Rust, Python, Bash, and all other languages `highlight.js` supports.",
    T1 + 27_000),

  turnEnd(13, S1, 0.031, 3124, 782, T1 + 30_000),

  // ---- Turn 2 ----
  userMsg(14, S1, "Looks great! Can you also add line numbers to the code blocks?", T1 + 120_000),

  textDelta(15, S1, "I'll add line numbers using CSS counters — no extra JS needed at render time.", T1 + 124_000),

  toolStart(16, S1, 'Edit', { file_path: 'src/components/ChatView.tsx' }, T1 + 126_000),

  toolResult(17, S1, "The file has been updated successfully.", false, T1 + 128_000),

  textDelta(18, S1,
    "\n\nLine numbers added. Each `<pre>` block now wraps in a `.code-with-lines` container " +
    "that uses `counter-reset` / `counter-increment` on `<code>` spans — one per line. " +
    "They render in a muted color with a right-border separator so they're distinct from the code itself.",
    T1 + 131_000),

  turnEnd(19, S1, 0.014, 1893, 234, T1 + 134_000),
]

// Session 2 — follow-up on theme-aware backgrounds
const S2 = 'demo-sess-md-2'
const T2 = T - 25 * 60_000

const SESSION2_LINES: OutputLine[] = [
  userMsg(1, S2,
    "The highlighting looks great but the code block background is too dark on the light theme. " +
    "Can you make it adapt to the current theme?",
    T2),

  thinkDelta(2, S2,
    "The user wants theme-aware code block backgrounds. I need to check how theming works " +
    "in this project — likely a data attribute on <html> or a CSS class.",
    T2 + 1_500),

  textDelta(3, S2, "I'll make the code block styles theme-aware. Let me check how the theme system works.", T2 + 5_000),

  toolStart(4, S2, 'Read', { file_path: 'src/lib/theme.ts' }, T2 + 7_000),

  toolResult(5, S2,
    "export function initTheme() {\n" +
    "  const saved = localStorage.getItem('verun:theme')\n" +
    "  document.documentElement.setAttribute('data-theme', saved || 'dark')\n" +
    "}",
    false, T2 + 8_000),

  textDelta(6, S2,
    "\n\nTheme is set via `data-theme` on `<html>`. I'll use that attribute in the CSS selectors " +
    "to pick the right `highlight.js` theme per color scheme.",
    T2 + 11_000),

  toolStart(7, S2, 'Edit', { file_path: 'src/styles/code.css' }, T2 + 13_000),

  toolResult(8, S2, "The file has been updated successfully.", false, T2 + 15_000),

  textDelta(9, S2,
    "\n\nDone. Code block backgrounds now switch automatically:\n\n" +
    "- `[data-theme='dark']` — uses the dark hljs theme (`github-dark`)\n" +
    "- `[data-theme='light']` — uses the light hljs theme (`github`)\n\n" +
    "No JavaScript changes needed — pure CSS attribute selectors handle it.",
    T2 + 18_000),

  turnEnd(10, S2, 0.009, 1247, 198, T2 + 20_000),
]

export const DEMO_OUTPUT_LINES: Record<string, OutputLine[]> = {
  [S1]: SESSION1_LINES,
  [S2]: SESSION2_LINES,
}

// ---------------------------------------------------------------------------
// UI selection for demo mode
// ---------------------------------------------------------------------------

export const DEMO_SELECTED = {
  projectId: 'demo-proj-verun',
  taskId: 'demo-task-md',
  sessionId: S1,
}

// Tasks that should appear with unread indicators in the sidebar
export const DEMO_UNREAD_TASK_IDS = ['demo-task-ctx', 'demo-task-diff']

// Tasks whose start command (dev server) should appear as running
export const DEMO_START_COMMAND_TASK_IDS = ['demo-task-md', 'demo-task-dark', 'demo-task-jwt']
