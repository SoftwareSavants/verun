import {
  Component,
  For,
  Show,
  Switch,
  Match,
  createSignal,
  createEffect,
  on,
  onCleanup,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { listen } from "@tauri-apps/api/event";
import { projects } from "../store/projects";
import {
  tasks,
  tasksForProject,
  loadTasks,
  deleteTask,
  isTaskCreating,
  getTaskError,
} from "../store/tasks";
import {
  selectedProjectId,
  setSelectedProjectId,
  selectedTaskId,
  setSelectedTaskId,
  showSettings,
  setShowSettings,
} from "../store/ui";
import { sessionsForTask, loadSessions } from "../store/sessions";
import { deleteProject, updateBaseBranch } from "../store/projects";
import { ConfirmDialog } from "./ConfirmDialog";
import { NewTaskDialog } from "./NewTaskDialog";
import { Dialog } from "./Dialog";
import { Popover } from "./Popover";
import {
  Plus,
  FolderPlus,
  Loader2,
  Circle,
  AlertCircle,
  GitPullRequest,
  GitMerge,
  CircleX,
  Archive,
  Folder,
  Settings,
  GitBranch,
} from "lucide-solid";
import { clsx } from "clsx";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { addProject } from "../store/projects";
import { addToast } from "../store/ui";
import * as ipc from "../lib/ipc";

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

interface TaskGitState {
  hasChanges: boolean;
  pushed: boolean;
  prState: string | null; // 'OPEN' | 'MERGED' | 'CLOSED' | null
  mergeable: string | null; // 'MERGEABLE' | 'CONFLICTING' | null
  ciFailed: boolean;
}

const [taskGitStates, setTaskGitStates] = createStore<
  Record<string, TaskGitState>
>({});

async function refreshTaskGitState(taskId: string) {
  try {
    const [gitStatus, prInfo, branchUrl] = await Promise.all([
      ipc.getGitStatus(taskId).catch(() => null),
      ipc.getPullRequest(taskId).catch(() => null),
      ipc.getBranchUrl(taskId).catch(() => null),
    ]);

    let ciFailed = false;
    if (prInfo) {
      const checks = await ipc.getCiChecks(taskId).catch(() => []);
      ciFailed = checks.some(
        (c) => c.status === "FAILURE" || c.status === "ERROR",
      );
    }

    setTaskGitStates(
      produce((s) => {
        s[taskId] = {
          hasChanges: (gitStatus?.files.length ?? 0) > 0,
          pushed: !!branchUrl,
          prState: prInfo?.state ?? null,
          mergeable: prInfo?.mergeable ?? null,
          ciFailed,
        };
      }),
    );
  } catch {
    // Silently fail — git state is supplementary
  }
}

function taskPhase(taskId: string): TaskPhase {
  // Session status takes priority for running/error
  const taskSessions = sessionsForTask(taskId);
  const hasRunning = taskSessions.some((s) => s.status === "running");
  if (hasRunning) return "running";

  const hasError = taskSessions.some((s) => s.status === "error");
  if (hasError) return "error";

  // Git/PR state
  const git = taskGitStates[taskId];
  if (git) {
    if (git.mergeable === "CONFLICTING") return "conflicts";
    if (git.ciFailed) return "ci-failed";
    if (git.prState === "MERGED") return "pr-merged";
    if (git.prState === "OPEN") return "pr-open";
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
interface MenuAction {
  label: string;
  action: () => void;
  danger?: boolean;
}

export const Sidebar: Component = () => {
  const [contextMenu, setContextMenu] = createSignal<{
    pos: MenuPos;
    items: MenuAction[];
  } | null>(null);
  const [confirmAction, setConfirmAction] = createSignal<{
    title: string;
    message: string;
    action: () => void;
  } | null>(null);
  const [newTaskProjectId, setNewTaskProjectId] = createSignal<string | null>(null);
  const [baseBranchProject, setBaseBranchProject] = createSignal<string | null>(null);
  const [branchOptions, setBranchOptions] = createSignal<string[]>([]);

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
          refreshTaskGitState(t.id);
        }
      },
    ),
  );

  // Listen for git-status-changed events to refresh specific tasks
  createEffect(() => {
    const unlisten = listen<{ taskId: string }>(
      "git-status-changed",
      (event) => {
        refreshTaskGitState(event.payload.taskId);
      },
    );
    onCleanup(() => {
      unlisten.then((fn) => fn());
    });
  });


  const handleSelectProject = (id: string) => {
    setSelectedProjectId(id);
  };

  const showProjectMenu = (e: MouseEvent, projectId: string) => {
    e.preventDefault();
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    setContextMenu({
      pos: { x: e.clientX, y: e.clientY },
      items: [
        {
          label: "Open in Finder",
          action: () => ipc.openInFinder(project.repoPath),
        },
        {
          label: `Base branch: ${project.baseBranch}`,
          action: async () => {
            setBaseBranchProject(projectId);
            try {
              const info = await ipc.getRepoInfo(project.repoPath);
              setBranchOptions(info.branches);
            } catch {
              setBranchOptions([project.baseBranch]);
            }
          },
        },
        {
          label: "Delete Project",
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
          label: "Open in Finder",
          action: () => ipc.openInFinder(task.worktreePath),
        },
        {
          label: "Delete Task",
          action: () =>
            setConfirmAction({
              title: "Delete Task",
              message:
                "This will delete all sessions and the worktree for this task.",
              action: () => deleteTask(taskId),
            }),
          danger: true,
        },
      ],
    });
  };

  const closeMenu = () => setContextMenu(null);

  return (
    <>
      {/* Context menu */}
      <Popover open={!!contextMenu()} onClose={closeMenu} pos={contextMenu()?.pos} class="py-1 min-w-40">
        <For each={contextMenu()?.items || []}>
          {(item) => (
            <button
              class={clsx(
                "w-full text-left px-3 py-1.5 text-xs transition-colors",
                item.danger
                  ? "text-status-error hover:bg-status-error/10"
                  : "text-text-secondary hover:bg-surface-4 hover:text-text-primary",
              )}
              onClick={() => {
                item.action();
                closeMenu();
              }}
            >
              {item.label}
            </button>
          )}
        </For>
      </Popover>

      <div class="h-full bg-surface-1 flex flex-col overflow-hidden">
        {/* Titlebar drag region */}
        <div class="h-12 shrink-0 drag-region" />

        {/* Header */}
        <div class="px-4 pb-2 flex items-center justify-between no-drag">
          <span class="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
            Projects
          </span>
          <button
            class="p-1 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
            onClick={async () => {
              const selected = await openDialog({ directory: true, multiple: false });
              if (!selected) return;
              try {
                const project = await addProject(selected as string);
                setSelectedProjectId(project.id);
                addToast(`Added ${project.name}`, "success");
              } catch (e) {
                addToast(String(e), "error");
              }
            }}
            title="Add Project (⌘O)"
          >
            <FolderPlus size={14} />
          </button>
        </div>

        {/* Project + task list */}
        <div class="flex-1 overflow-y-auto overflow-x-hidden px-3 no-drag">
          <For each={projects}>
            {(project) => (
              <div class="mb-1">
                <div
                  class="w-full text-left px-2 py-1.5 rounded-lg transition-colors flex items-center justify-between group cursor-pointer min-w-0"
                  onClick={() => handleSelectProject(project.id)}
                  onContextMenu={(e) => showProjectMenu(e, project.id)}
                >
                  <span class="text-sm text-text-primary truncate flex items-center gap-1.5">
                    <Folder size={13} class="shrink-0 text-text-dim" />
                    {project.name}
                  </span>
                  <button
                    class="p-0.5 rounded opacity-60 group-hover:opacity-100 transition-opacity text-text-muted hover:text-text-secondary shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      setNewTaskProjectId(project.id);
                    }}
                    title="New Task (⌘N)"
                  >
                    <Plus size={14} />
                  </button>
                </div>

                <Show
                  when={
                    tasksForProject(project.id).length === 0 &&
                    selectedProjectId() === project.id
                  }
                >
                  <div
                    class="ml-2.5 pl-4 py-0.5"
                    style={{ "border-left": "1px solid #3a3a48" }}
                  >
                    <button
                      class="text-[10px] text-text-dim hover:text-text-muted transition-colors cursor-pointer"
                      onClick={() => setNewTaskProjectId(project.id)}
                    >
                      + New task
                    </button>
                  </div>
                </Show>

                <Show when={tasksForProject(project.id).length > 0}>
                  <div
                    class="ml-2.5 mt-0.5 pl-2 flex flex-col gap-0.5"
                    style={{ "border-left": "1px solid #3a3a48" }}
                  >
                    <For each={tasksForProject(project.id)}>
                      {(task) => {
                        const phase = () => taskPhase(task.id);
                        const config = () => PHASE_CONFIG[phase()];
                        const creating = () => isTaskCreating(task.id);
                        const hasError = () => !!getTaskError(task.id);
                        return (
                          <div
                            class={clsx(
                              "group/task pl-2 pr-2 py-1.5 rounded-md transition-colors flex items-start gap-2 cursor-pointer",
                              "hover:bg-surface-2",
                              selectedTaskId() === task.id && "bg-surface-2",
                            )}
                            onClick={() => { setSelectedTaskId(task.id); setSelectedProjectId(task.projectId); setShowSettings(false) }}
                            onContextMenu={(e) => { if (!creating() && !hasError()) showTaskMenu(e, task.id) }}
                            title={creating() ? 'Setting up…' : hasError() ? 'Setup failed' : config().title}
                          >
                            <span
                              class={clsx("shrink-0 mt-0.5", creating() ? 'text-accent' : hasError() ? 'text-status-error' : config().color)}
                            >
                              {creating() ? <Loader2 size={12} class="animate-spin" /> : hasError() ? <AlertCircle size={12} /> : <PhaseIcon phase={phase()} />}
                            </span>
                            <div class="flex-1 min-w-0">
                              <div class="text-xs text-text-secondary truncate">
                                {task.name || "New task"}
                              </div>
                              <div class="text-[10px] text-text-dim truncate">
                                {task.branch}
                              </div>
                            </div>
                            <button
                              class="shrink-0 p-0.5 rounded opacity-0 group-hover/task:opacity-60 hover:!opacity-100 text-text-dim hover:text-status-error transition-all"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmAction({
                                  title: "Delete Task",
                                  message:
                                    "This will delete all sessions and the worktree for this task.",
                                  action: () => deleteTask(task.id),
                                });
                              }}
                              title="Delete task"
                            >
                              <Archive size={12} />
                            </button>
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
                  if (!selected) return;
                  try {
                    const project = await addProject(selected as string);
                    setSelectedProjectId(project.id);
                    addToast(`Added ${project.name}`, "success");
                  } catch (e) {
                    addToast(String(e), "error");
                  }
                }}
              >
                Add Project
              </button>
            </div>
          </Show>
        </div>

        {/* Settings footer */}
        <button
          class={`w-full px-4 py-3 border-t border-border-subtle flex items-center gap-2 transition-colors no-drag ${
            showSettings() ? 'text-text-secondary' : 'text-text-dim hover:text-text-muted'
          }`}
          onClick={() => setShowSettings(!showSettings())}
        >
          <Settings size={13} />
          <span class="text-[11px]">Settings</span>
        </button>
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

      <NewTaskDialog
        open={!!newTaskProjectId()}
        projectId={newTaskProjectId()}
        onClose={() => setNewTaskProjectId(null)}
      />

      <Dialog open={!!baseBranchProject()} onClose={() => setBaseBranchProject(null)} width="18rem">
        <h2 class="text-base font-semibold text-text-primary mb-3">Base Branch</h2>
        <div class="flex flex-col gap-1 max-h-48 overflow-y-auto">
          <For each={branchOptions()}>
            {(branch) => {
              const project = () => projects.find(p => p.id === baseBranchProject());
              const isActive = () => project()?.baseBranch === branch;
              return (
                <button
                  class={clsx(
                    "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-left transition-colors",
                    isActive() ? "bg-accent/15 text-accent" : "text-text-secondary hover:bg-surface-3"
                  )}
                  onClick={async () => {
                    const pid = baseBranchProject();
                    if (pid) {
                      await updateBaseBranch(pid, branch);
                      addToast(`Base branch set to ${branch}`, 'success');
                    }
                    setBaseBranchProject(null);
                  }}
                >
                  <GitBranch size={13} class="shrink-0" />
                  {branch}
                </button>
              );
            }}
          </For>
        </div>
        <div class="flex justify-end mt-3">
          <button class="btn-ghost text-xs" onClick={() => setBaseBranchProject(null)}>Cancel</button>
        </div>
      </Dialog>
    </>
  );
};
