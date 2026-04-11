import {
  Component,
  For,
  Show,
  Switch,
  Match,
  createSignal,
  createEffect,
  on,
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
  selectedProjectId,
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
} from "../store/ui";
import { sessionsForTask, loadSessions } from "../store/sessions";
import { deleteProject } from "../store/projects";
import { ConfirmDialog } from "./ConfirmDialog";
import { NewTaskDialog } from "./NewTaskDialog";
import { AddProjectDialog } from "./AddProjectDialog";
import { Popover } from "./Popover";
import { selectSettingsSection } from "./SettingsPage";
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
} from "lucide-solid";
import { clsx } from "clsx";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as ipc from "../lib/ipc";
import { hasOverlayTitlebar } from "../lib/platform";

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

function taskPhase(taskId: string): TaskPhase {
  // Session status takes priority for running/error
  const taskSessions = sessionsForTask(taskId);
  const hasRunning = taskSessions.some((s) => s.status === "running");
  if (hasRunning) return "running";

  const hasError = taskSessions.some((s) => s.status === "error");
  if (hasError) return "error";

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
  const [archiveTaskTarget, setArchiveTaskTarget] = createSignal<string | null>(null);
  const [newTaskProjectId, setNewTaskProjectId] = createSignal<string | null>(null);
  const [renamingTaskId, setRenamingTaskId] = createSignal<string | null>(null);

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
          label: "Project Settings",
          action: () => {
            setShowSettings(true);
            selectSettingsSection(projectId);
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
          label: "Open in New Window",
          action: () => ipc.openTaskWindow(task.id, task.name || undefined),
        },
        {
          label: "Rename",
          action: () => setRenamingTaskId(taskId),
        },
        {
          label: "Open in Finder",
          action: () => ipc.openInFinder(task.worktreePath),
        },
        {
          label: "Archive Task",
          action: () => setArchiveTaskTarget(taskId),
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
        {/* Titlebar drag region (macOS overlay titlebar) */}
        <Show when={hasOverlayTitlebar}><div class="h-12 shrink-0 drag-region" data-tauri-drag-region /></Show>

        {/* Header */}
        <div class="px-4 pb-2 flex items-center justify-between no-drag">
          <span class="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
            Projects
          </span>
          <button
            class="p-1 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
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
                    activeTasksForProject(project.id).length === 0 &&
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

                <Show when={activeTasksForProject(project.id).length > 0}>
                  <div
                    class="ml-2.5 mt-0.5 pl-2 flex flex-col gap-0.5"
                    style={{ "border-left": "1px solid #3a3a48" }}
                  >
                    <For each={activeTasksForProject(project.id)}>
                      {(task) => {
                        const phase = () => taskPhase(task.id);
                        const config = () => PHASE_CONFIG[phase()];
                        const creating = () => isTaskCreating(task.id);
                        const archiving = () => isTaskArchiving(task.id);
                        const hasError = () => !!getTaskError(task.id);
                        const attention = () => isTaskAttention(task.id);
                        const unread = () => !attention() && isTaskUnread(task.id);
                        const hasIndicator = () => attention() || unread();
                        const disabled = () => creating() || archiving();
                        return (
                          <div
                            class={clsx(
                              "group/task pl-2 pr-2 py-1.5 rounded-md transition-colors flex items-start gap-2 cursor-pointer",
                              "hover:bg-surface-2",
                              selectedTaskId() === task.id && "bg-surface-2",
                              attention() && "bg-amber-400/8",
                              unread() && "bg-accent/8",
                              archiving() && "opacity-50 pointer-events-none",
                            )}
                            style={{
                              "border-left": attention() ? "2px solid #fbbf24" :
                                             unread() ? "2px solid #2d6e4f" :
                                             "2px solid transparent",
                              "border-radius": (attention() || unread()) ? "0 6px 6px 0" : undefined,
                            }}
                            onClick={() => { setSelectedTaskId(task.id); setSelectedProjectId(task.projectId); setShowSettings(false); setShowArchived(false) }}
                            onDblClick={() => { if (!disabled() && !hasError()) ipc.openTaskWindow(task.id, task.name || undefined) }}
                            onContextMenu={(e) => { if (!disabled() && !hasError()) showTaskMenu(e, task.id) }}
                            title={archiving() ? 'Archiving…' : creating() ? 'Setting up…' : hasError() ? 'Setup failed' : config().title}
                          >
                            <span
                              class={clsx("shrink-0 mt-0.5", disabled() ? 'text-accent' : hasError() ? 'text-status-error' : config().color)}
                            >
                              {disabled() ? <Loader2 size={12} class="animate-spin" /> : hasError() ? <AlertCircle size={12} /> : <PhaseIcon phase={phase()} />}
                            </span>
                            <div class="flex-1 min-w-0">
                              <Show when={renamingTaskId() === task.id} fallback={
                                <div class={clsx("text-xs truncate", hasIndicator() ? "text-text-primary font-medium" : "text-text-secondary")}>
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
                              <div class={clsx("text-[10px] truncate", hasIndicator() ? "text-text-muted" : "text-text-dim")}>
                                {task.branch}
                              </div>
                            </div>
                            <Show when={!archiving()}>
                              <button
                                class="shrink-0 p-0.5 rounded opacity-0 group-hover/task:opacity-60 hover:!opacity-100 text-text-dim hover:text-text-muted transition-all"
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

        {/* Footer */}
        <div class="border-t border-border-subtle flex flex-col no-drag">
          <button
            class={`w-full px-4 py-2.5 flex items-center gap-2 transition-colors ${
              showArchived() ? 'text-text-secondary' : 'text-text-dim hover:text-text-muted'
            }`}
            onClick={() => {
              const next = !showArchived()
              setShowArchived(next)
              if (next) { setShowSettings(false); setSelectedTaskId(null) }
            }}
          >
            <Archive size={13} />
            <span class="text-[11px]">Archived</span>
          </button>
          <button
            class={`w-full px-4 py-2.5 flex items-center gap-2 transition-colors ${
              showSettings() ? 'text-text-secondary' : 'text-text-dim hover:text-text-muted'
            }`}
            onClick={() => {
              const next = !showSettings()
              setShowSettings(next)
              if (next) setShowArchived(false)
            }}
          >
            <Settings size={13} />
            <span class="text-[11px]">Settings</span>
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
            if (selectedTaskId() === target) setSelectedTaskId(null)
            archiveTask(target)
          }
          setArchiveTaskTarget(null);
        }}
        onCancel={() => setArchiveTaskTarget(null)}
      />

      <NewTaskDialog
        open={!!newTaskProjectId()}
        projectId={newTaskProjectId()}
        onClose={() => setNewTaskProjectId(null)}
      />

      <AddProjectDialog
        open={!!addProjectPath()}
        repoPath={addProjectPath()}
        onClose={() => setAddProjectPath(null)}
        onAdded={(id) => { setSelectedProjectId(id); setNewTaskProjectId(id) }}
      />
    </>
  );
};
