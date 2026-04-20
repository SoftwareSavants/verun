import {
  Component,
  For,
  Show,
  Switch,
  Match,
  createSignal,
  createMemo,
  createEffect,
  on,
  onMount,
  onCleanup,
} from "solid-js";
import { taskGit, refreshTaskGit } from "../store/git";
import { projects } from "../store/projects";
import {
  tasks,
  activeTasksForProject,
  loadTasks,
  archiveTask,
  isTaskCreating,
  isTaskArchiving,
  getTaskError,
  updateTaskName,
} from "../store/tasks";
import {
  setSelectedProjectId,
  selectedTaskId,
  setSelectedTaskId,
  showSettings,
  setShowSettings,
  showArchived,
  setShowArchived,
  isTaskUnread,
  isTaskAttention,
  clearTaskIndicators,
  addProjectPath,
  setAddProjectPath,
  isTaskWindowed,
  markTaskWindowed,
  requestNewTaskForProject,
  focusOrSelectTask,
} from "../store/ui";
import { sessions, loadSessions } from "../store/sessions";
import { isStartCommandRunning } from "../store/terminals";
import { deleteProject } from "../store/projects";
import { ConfirmDialog } from "./ConfirmDialog";
import { AddProjectDialog } from "./AddProjectDialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { selectSettingsSection } from "./SettingsPage";
import {
  Plus,
  FolderPlus,
  FolderOpen,
  Pencil,
  Trash2,
  Loader2,
  Circle,
  AlertCircle,
  GitPullRequest,
  GitMerge,
  CircleX,
  Archive,
  Settings,
  Play,
} from "lucide-solid";
import { clsx } from "clsx";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "../lib/ipc";
import { ExternalLink, GitBranch } from "lucide-solid";

// ---------------------------------------------------------------------------
// Per-project chip color — deterministic hash → palette index. Subtle bg
// (low alpha) + saturated text for legibility against the dark sidebar.
// ---------------------------------------------------------------------------

const PROJECT_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#eab308', // yellow
  '#84cc16', // lime
  '#22c55e', // green
  '#10b981', // emerald
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#0ea5e9', // sky
  '#3b82f6', // blue
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#a855f7', // purple
  '#d946ef', // fuchsia
  '#ec4899', // pink
  '#f43f5e', // rose
  '#78716c', // stone
] as const;

function projectColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}

// ---------------------------------------------------------------------------
// Composite task status — richer than just session status
// ---------------------------------------------------------------------------

type TaskPhase =
  | "idle" // nothing happening
  | "running" // session actively running
  | "error" // session errored
  | "pr-open" // PR created and open
  | "ci-failed" // PR has failing CI checks
  | "conflicts" // PR has merge conflicts
  | "pr-merged"; // PR merged

function taskPhase(taskId: string, sessionPhase: Record<string, "running" | "error" | undefined>): TaskPhase {
  if (sessionPhase[taskId] === "running") return "running";
  if (sessionPhase[taskId] === "error") return "error";
  // Git/PR state from centralized store
  const git = taskGit(taskId);
  if (git.pr) {
    if (git.pr.mergeable === "CONFLICTING") return "conflicts";
    if (git.checks.some(c => c.status === "FAILURE" || c.status === "ERROR")) return "ci-failed";
    if (git.pr.state === "MERGED") return "pr-merged";
    if (git.pr.state === "OPEN") return "pr-open";
  }

  return "idle";
}

const PHASE_CONFIG: Record<TaskPhase, { color: string; title: string }> = {
  idle: { color: "text-status-idle", title: "Idle" },
  running: { color: "text-text-muted", title: "Running" },
  error: { color: "text-status-error", title: "Error" },
  "pr-open": { color: "text-emerald-400", title: "PR open" },
  "ci-failed": { color: "text-red-400", title: "CI failing" },
  conflicts: { color: "text-amber-400", title: "Merge conflicts" },
  "pr-merged": { color: "text-purple-400", title: "Merged" },
};

const PhaseIcon: Component<{ phase: TaskPhase }> = (props) => {
  const size = 12;
  return (
    <Switch fallback={<Circle size={size} />}>
      <Match when={props.phase === "running"}>
        <Loader2 size={size} class="animate-spin" />
      </Match>
      <Match when={props.phase === "error"}>
        <AlertCircle size={size} />
      </Match>
      <Match when={props.phase === "pr-open"}>
        <GitPullRequest size={size} />
      </Match>
      <Match when={props.phase === "ci-failed"}>
        <CircleX size={size} />
      </Match>
      <Match when={props.phase === "conflicts"}>
        <CircleX size={size} />
      </Match>
      <Match when={props.phase === "pr-merged"}>
        <GitMerge size={size} />
      </Match>
    </Switch>
  );
};

interface MenuPos {
  x: number;
  y: number;
}
type MenuItem = ContextMenuItem;

export const Sidebar: Component = () => {
  const [contextMenu, setContextMenu] = createSignal<{
    pos: MenuPos;
    items: MenuItem[];
  } | null>(null);
  const [confirmAction, setConfirmAction] = createSignal<{
    title: string;
    message: string;
    action: () => void;
  } | null>(null);
  const [archiveTaskTarget, setArchiveTaskTarget] = createSignal<string | null>(null);
  const [renamingTaskId, setRenamingTaskId] = createSignal<string | null>(null);

  const activeTasksByProject = createMemo(() => {
    const byProject: Record<string, typeof tasks> = {}
    for (const p of projects) byProject[p.id] = activeTasksForProject(p.id)
    return byProject
  })

  const taskBindingById = createMemo(() => {
    const map: Record<string, number | null> = {}
    let idx = 0
    for (const p of projects) {
      for (const t of activeTasksByProject()[p.id] || []) {
        map[t.id] = idx < 9 ? idx : null
        idx++
      }
    }
    return map
  })

  const sessionPhaseByTask = createMemo(() => {
    const map: Record<string, "running" | "error" | undefined> = {}
    for (const s of sessions) {
      if (s.status === "running") {
        map[s.taskId] = "running"
      } else if (s.status === "error" && map[s.taskId] !== "running") {
        map[s.taskId] = "error"
      }
    }
    return map
  })

  // Cmd+1…Cmd+9 selects tasks in sidebar order. Returns 0-8 for keybound tasks,
  // null for tasks beyond the 9th (no shortcut) so we don't show ⌘0 etc.
  const taskBindingIndex = (taskId: string): number | null => {
    return taskBindingById()[taskId] ?? null;
  };

  // Track which tasks have open windows
  onMount(() => {
    const unlisten = listen<{ taskId: string; open: boolean }>("task-window-changed", (event) => {
      markTaskWindowed(event.payload.taskId, event.payload.open);
    });
    onCleanup(() => { unlisten.then(fn => fn()) });
  });

  // Clear unread/attention indicators when user selects a task
  createEffect(
    on(selectedTaskId, (id) => {
      if (id) clearTaskIndicators(id);
    }),
  );

  // Load tasks for all projects on mount / when projects change
  createEffect(
    on(
      () => projects.length,
      () => {
        for (const p of projects) {
          loadTasks(p.id);
        }
      },
    ),
  );

  // Load sessions + git state for all tasks on mount and when tasks change
  createEffect(
    on(
      () => tasks.length,
      () => {
        for (const t of tasks) {
          loadSessions(t.id);
          refreshTaskGit(t.id);
        }
      },
    ),
  );


  const showProjectMenu = (e: MouseEvent, projectId: string) => {
    e.preventDefault();
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    setContextMenu({
      pos: { x: e.clientX, y: e.clientY },
      items: [
        {
          label: "Open in Finder",
          icon: FolderOpen,
          action: () => ipc.openInFinder(project.repoPath),
        },
        {
          label: "Project Settings",
          icon: Settings,
          action: () => {
            setShowSettings(true);
            selectSettingsSection(projectId);
          },
        },
        { separator: true },
        {
          label: "Delete Project",
          icon: Trash2,
          action: () =>
            setConfirmAction({
              title: "Delete Project",
              message:
                "This will delete all tasks, sessions, and worktrees for this project.",
              action: () => deleteProject(projectId),
            }),
          danger: true,
        },
      ],
    });
  };

  const showTaskMenu = (e: MouseEvent, taskId: string) => {
    e.preventDefault();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    setContextMenu({
      pos: { x: e.clientX, y: e.clientY },
      items: [
        {
          label: "Open in New Window",
          icon: ExternalLink,
          action: () => ipc.openTaskWindow(task.id, task.name || undefined),
        },
        {
          label: "Rename",
          icon: Pencil,
          action: () => setRenamingTaskId(taskId),
        },
        {
          label: "Open in Finder",
          icon: FolderOpen,
          action: () => ipc.openInFinder(task.worktreePath),
        },
        { separator: true },
        {
          label: "Archive Task",
          icon: Archive,
          action: () => setArchiveTaskTarget(taskId),
        },
      ],
    });
  };

  const closeMenu = () => setContextMenu(null);

  return (
    <>
      {/* Context menu */}
      <ContextMenu
        open={!!contextMenu()}
        onClose={closeMenu}
        pos={contextMenu()?.pos}
        items={contextMenu()?.items || []}
      />

      <div class="h-full bg-surface-1 flex flex-col overflow-hidden">
        {/* Header — also serves as titlebar drag region */}
        <div class="px-2 pt-10 pb-1.5 flex items-center justify-between drag-region" data-tauri-drag-region>
          <span class="text-[10px] font-semibold uppercase tracking-wider text-text-muted px-1 no-drag">Projects</span>
          <button
            class="p-1 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors no-drag"
            onClick={async () => {
              const selected = await openDialog({ directory: true, multiple: false });
              if (selected) setAddProjectPath(selected as string);
            }}
            title="Add Project (⌘O)"
          >
            <FolderPlus size={14} />
          </button>
        </div>

        {/* Project + task list */}
        <div class="flex-1 overflow-y-auto overflow-x-hidden px-2 no-drag">
          <For each={projects}>
            {(project) => (
              <div class="mb-3">
                <div
                  class="w-full text-left px-2 py-1 rounded-md flex items-center justify-between group cursor-pointer min-w-0 hover:bg-surface-2"
                  onContextMenu={(e) => showProjectMenu(e, project.id)}
                >
                  <span class="flex items-center gap-2 min-w-0">
                    <span
                      class="shrink-0 w-4 h-4 rounded-sm text-[10px] font-semibold uppercase flex items-center justify-center"
                      style={{
                        'background-color': projectColor(project.id) + '26',
                        color: projectColor(project.id),
                      }}
                    >
                      {project.name.charAt(0)}
                    </span>
                    <span class="text-[10px] font-semibold uppercase tracking-wider text-text-muted truncate">
                      {project.name}
                    </span>
                  </span>
                  <button
                    class="p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-text-secondary shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      requestNewTaskForProject(project.id);
                    }}
                    title="New Task (⌘N)"
                  >
                    <Plus size={12} />
                  </button>
                </div>

                <Show when={(activeTasksByProject()[project.id] || []).length === 0}>
                  <div class="px-2 pt-1">
                    <button
                      class="text-[10px] text-text-dim hover:text-text-muted transition-colors cursor-pointer"
                      onClick={() => requestNewTaskForProject(project.id)}
                    >
                      + New task
                    </button>
                  </div>
                </Show>

                <Show when={(activeTasksByProject()[project.id] || []).length > 0}>
                  <div class="mt-1 flex flex-col gap-0.5">
                    <For each={activeTasksByProject()[project.id] || []}>
                      {(task) => {
                        const phase = () => taskPhase(task.id, sessionPhaseByTask());
                        const config = () => PHASE_CONFIG[phase()];
                        const creating = () => isTaskCreating(task.id);
                        const archiving = () => isTaskArchiving(task.id);
                        const hasError = () => !!getTaskError(task.id);
                        const attention = () => isTaskAttention(task.id);
                        const unread = () => !attention() && isTaskUnread(task.id);
                        const hasIndicator = () => attention() || unread();
                        const disabled = () => creating() || archiving();
                        const windowed = () => isTaskWindowed(task.id);
                        const bindingIdx = () => taskBindingIndex(task.id);

                        const handleClick = () => focusOrSelectTask(task);

                        const isSelected = () => !windowed() && selectedTaskId() === task.id;

                        return (
                          <div
                            class={clsx(
                              "group/task relative pl-3 pr-2 py-1.5 rounded-md flex items-center gap-2 cursor-pointer",
                              isSelected()
                                ? "bg-surface-2"
                                : "hover:bg-surface-2",
                              !isSelected() && attention() && "task-attention-pulse",
                              !isSelected() && !attention() && unread() && "task-unread-pulse",
                              archiving() && "opacity-50 pointer-events-none",
                              windowed() && "opacity-50",
                            )}
                            style={isSelected() ? { 'box-shadow': 'inset 2px 0 0 #2d6e4f' } : undefined}
                            onClick={handleClick}
                            onDblClick={() => { if (!disabled() && !hasError()) ipc.openTaskWindow(task.id, task.name || undefined) }}
                            onContextMenu={(e) => { if (!disabled() && !hasError()) showTaskMenu(e, task.id) }}
                            title={windowed() ? 'Open in separate window — click to focus' : archiving() ? 'Archiving…' : creating() ? 'Setting up…' : hasError() ? 'Setup failed' : config().title}
                          >
                            <span
                              class={clsx("shrink-0", disabled() ? 'text-accent' : hasError() ? 'text-status-error' : config().color)}
                            >
                              {disabled() ? <Loader2 size={12} class="animate-spin" /> : hasError() ? <AlertCircle size={12} /> : <PhaseIcon phase={phase()} />}
                            </span>
                            <div class={clsx("flex-1 min-w-0", bindingIdx() !== null && "pr-7")}>
                              <Show when={renamingTaskId() === task.id} fallback={
                                <div class={clsx(
                                  "text-xs truncate",
                                  hasIndicator() || isSelected() ? "text-text-primary font-medium" : "text-text-secondary"
                                )}>
                                  {task.name || "New task"}
                                </div>
                              }>
                                <input
                                  class="text-xs bg-bg-secondary text-text-primary border border-border-active rounded px-1 py-0 w-full outline-none"
                                  value={task.name || ""}
                                  ref={(el) => requestAnimationFrame(() => { el.focus(); el.select() })}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      const val = e.currentTarget.value.trim()
                                      if (val) updateTaskName(task.id, val)
                                      setRenamingTaskId(null)
                                    } else if (e.key === 'Escape') {
                                      setRenamingTaskId(null)
                                    }
                                  }}
                                  onBlur={(e) => {
                                    const val = e.currentTarget.value.trim()
                                    if (val) updateTaskName(task.id, val)
                                    setRenamingTaskId(null)
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </Show>
                              <div class={clsx("text-[10px] truncate flex items-center gap-1", hasIndicator() || isSelected() ? "text-text-muted" : "text-text-dim")}>
                                <Show when={task.parentTaskId}>
                                  <GitBranch size={9} class="shrink-0 text-text-dim/70" />
                                </Show>
                                {task.branch}
                                <Show when={isStartCommandRunning(task.id)}>
                                  <Play size={9} class="shrink-0 text-green-400 fill-green-400 animate-pulse" />
                                </Show>
                                <Show when={isTaskWindowed(task.id)}>
                                  <ExternalLink size={9} class="shrink-0 text-accent/60" />
                                </Show>
                              </div>
                            </div>
                            <Show when={!archiving()}>
                              <Show when={bindingIdx() !== null}>
                                <kbd class="absolute right-2 top-1/2 -translate-y-1/2 -mt-px h-5 flex items-center leading-none text-[10px] font-mono text-text-dim pointer-events-none group-hover/task:opacity-0 transition-opacity">
                                  {'\u2318'}{bindingIdx()! + 1}
                                </kbd>
                              </Show>
                              <button
                                class="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded opacity-0 group-hover/task:opacity-100 text-text-dim hover:text-text-muted bg-surface-2"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setArchiveTaskTarget(task.id);
                                }}
                                title="Archive task"
                              >
                                <Archive size={12} />
                              </button>
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>

              </div>
            )}
          </For>

          {/* Empty state */}
          <Show when={projects.length === 0}>
            <div class="px-3 py-10 flex flex-col items-center">
              <div class="w-10 h-10 rounded-xl bg-surface-3 flex items-center justify-center mb-4">
                <FolderPlus size={20} class="text-text-muted" />
              </div>
              <p class="text-sm text-text-primary font-medium mb-1">
                Add a git repo
              </p>
              <p class="text-xs text-text-dim text-center leading-relaxed mb-5">
                Each repo becomes a project. Create tasks to spin up parallel
                worktrees.
              </p>
              <button
                class="btn-primary text-xs px-4 py-1.5"
                onClick={async () => {
                  const selected = await openDialog({ directory: true, multiple: false });
                  if (selected) setAddProjectPath(selected as string);
                }}
              >
                Add Project
              </button>
            </div>
          </Show>
        </div>

        {/* Footer — compact icon strip */}
        <div class="border-t border-border-subtle flex items-center gap-1 px-2 py-1.5 no-drag">
          <button
            class={clsx(
              'p-1.5 rounded-md transition-colors',
              showArchived()
                ? 'text-accent bg-accent-muted'
                : 'text-text-dim hover:text-text-secondary hover:bg-surface-3'
            )}
            onClick={() => {
              const next = !showArchived()
              setShowArchived(next)
              if (next) { setShowSettings(false); setSelectedTaskId(null) }
            }}
            title="Archived"
          >
            <Archive size={14} />
          </button>
          <button
            class={clsx(
              'p-1.5 rounded-md transition-colors',
              showSettings()
                ? 'text-accent bg-accent-muted'
                : 'text-text-dim hover:text-text-secondary hover:bg-surface-3'
            )}
            onClick={() => {
              const next = !showSettings()
              setShowSettings(next)
              if (next) setShowArchived(false)
            }}
            title="Settings"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmAction()}
        title={confirmAction()?.title || ""}
        message={confirmAction()?.message || ""}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          confirmAction()?.action();
          setConfirmAction(null);
        }}
        onCancel={() => setConfirmAction(null)}
      />

      <ConfirmDialog
        open={!!archiveTaskTarget()}
        title="Archive Task"
        message="This will stop all sessions and archive this task."
        confirmLabel="Archive"
        onConfirm={() => {
          const target = archiveTaskTarget();
          if (target) {
            archiveTask(target)
          }
          setArchiveTaskTarget(null);
        }}
        onCancel={() => setArchiveTaskTarget(null)}
      />

      <AddProjectDialog
        open={!!addProjectPath()}
        repoPath={addProjectPath()}
        onClose={() => setAddProjectPath(null)}
        onAdded={(id) => { setSelectedProjectId(id); requestNewTaskForProject(id) }}
      />
    </>
  );
};
