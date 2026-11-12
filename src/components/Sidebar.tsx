import { openTaskBoard, showTaskBoard } from '../store/ui';
import { taskStatus, needsYou } from '../store/taskStatus';
import { TaskStatusIcon } from './TaskStatusIcon';
import { KeepAwakeButton } from './KeepAwakeButton';
import { StatusKey } from './StatusKey';
import { openQuickTask } from '../store/quickTasks';
import { projectColor } from '../lib/projectColor';
import { Columns3 } from 'lucide-solid';
import {
  Component,
  For,
  Show,
  createSignal,
  createMemo,
  createEffect,
  on,
  onMount,
  onCleanup,
  type JSX,
} from "solid-js";
import type { Task } from "../types";
import { useNow } from "../lib/subagents";
import { formatAgo } from "../lib/format";
import { recentTasks } from "../lib/recentTasks";
import { lastActiveAt } from "../store/lastActive";
import { sidebarView } from "../store/sidebarView";
import { RecentTaskList } from "./RecentTaskList";
import { refreshTaskGit } from "../store/git";
import { syncWatchedWorktrees } from "../store/worktreeWatch";
import { newTaskIds } from "../lib/taskDiff";
import { GroupHeading, GroupToolbar } from './ProjectGroups';
import { Dialog } from './Dialog';
import { Select } from './Select';
import { groupState, projectQuery, projectSections, visibleProjects, projectGroup, groupName, moveProject, revealProject, syncProjectGroups } from '../store/projectGroups';
import { projects } from "../store/projects";
import {
  tasks,
  activeTasksForProject,
  loadTasks,
  archiveTask,
  isTaskCreating,
  getCloudTaskPhase,
  retryCloudTaskImport,
  isTaskArchiving,
  getTaskError,
  updateTaskName,
} from "../store/tasks";
import {
  selectedTaskId,
  setSelectedProjectId,
  setSelectedTaskId,
  showSettings,
  setShowSettings,
  showArchived,
  setShowArchived,
  isTaskUnread,
  clearTaskIndicators,
  setAddProjectPath,
  setShowBtsBuilder,
  setShowCloneRepo,
  isTaskWindowed,
  markTaskWindowed,
  requestNewTaskForProject,
  focusOrSelectTask,
  setShowTerminal,
} from "../store/ui";
import { loadSessions } from "../store/sessions";
import { isStartCommandRunning, spawnStartCommand, stopStartCommand } from "../store/terminals";
import { isSetupRunning } from "../store/setup";
import { deleteProject, projectById } from "../store/projects";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { buildAddProjectMenuItems } from "../lib/addProjectMenu";
import { buildTaskMenuItems } from "../lib/taskMenu";
import { selectSettingsSection } from "./SettingsPage";
import {
  Plus,
  FolderOpen,
  Trash2,
  Archive,
  Settings,
  Play,
  LoaderCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-solid";
import { clsx } from "clsx";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "../lib/ipc";
import { ExternalLink, GitBranch } from "lucide-solid";

interface MenuPos {
  x: number;
  y: number;
}
type MenuItem = ContextMenuItem;

const QUEUE_COLLAPSED_KEY = 'verun:needsYouCollapsed';
const readQueueCollapsed = () => { try { return localStorage.getItem(QUEUE_COLLAPSED_KEY) === 'true' } catch { return false } };

export const Sidebar: Component = () => {
  const [queueCollapsed, setQueueCollapsedSignal] = createSignal(readQueueCollapsed());
  const setQueueCollapsed = (v: boolean) => {
    setQueueCollapsedSignal(v);
    try { localStorage.setItem(QUEUE_COLLAPSED_KEY, String(v)) } catch { /* ignore */ }
  };
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

  const [movingProject, setMovingProject] = createSignal<string | null>(null);
  const [moveTarget, setMoveTarget] = createSignal('ungrouped');
  const [groupError, setGroupError] = createSignal('');
  const sections = createMemo(() => projectSections(projects));
  const attentionTasks = (groupId: string) => tasks.filter(t => !t.archived && projectGroup(t.projectId) === groupId && needsYou(t.id));
  const otherAttention = createMemo(() => groupState().scope === 'all' ? [] :
    [...groupState().groups, { id: 'ungrouped', name: 'Ungrouped' }]
      .filter(g => g.id !== groupState().scope)
      .map(g => ({ ...g, count: attentionTasks(g.id).length })).filter(g => g.count > 0));
  const reveal = (projectId: string) => {
    revealProject(projectId);
    setSelectedProjectId(projectId);
    const task = activeTasksForProject(projectId)[0];
    if (task) focusOrSelectTask(task);
  };
  const jumpToAttention = (groupId: string) => {
    const task = attentionTasks(groupId)[0];
    if (task) { revealProject(task.projectId); focusOrSelectTask(task); }
  };
  onMount(() => {
    window.addEventListener('storage', syncProjectGroups);
    onCleanup(() => window.removeEventListener('storage', syncProjectGroups));
  });

  const activeTasksByProject = createMemo(() => {
    const byProject: Record<string, typeof tasks> = {}
    for (const p of projects) byProject[p.id] = activeTasksForProject(p.id)
    return byProject
  })

  // Everything blocked on the manager in the current scope, in sidebar order.
  const needsYouTasks = createMemo(() => visibleProjects(projects).flatMap(p => (activeTasksByProject()[p.id] || []).filter(t => needsYou(t.id))));
  // Tasks we can't read (hooks unavailable, before Claude reports in) could be
  // waiting too - surface them instead of letting them look quiet.
  const unknownCount = createMemo(() => visibleProjects(projects).flatMap(p => activeTasksByProject()[p.id] || []).filter(t => taskStatus(t.id).kind === 'unknown').length);
  const floor = createMemo(() => ({ running: tasks.filter(t => !t.archived && taskStatus(t.id).kind === 'running').length }));

  // Recent view: every task in scope in one list, newest first. The clock
  // only moves ages and folding once a minute.
  const now = useNow();
  const minute = createMemo(() => Math.floor(now() / 60_000) * 60_000);
  const recentView = createMemo(() => recentTasks(
    visibleProjects(projects).flatMap(p => (activeTasksByProject()[p.id] || []).map(task => ({
      id: task.id, task, column: taskStatus(task.id).column, lastActive: lastActiveAt(task),
    }))),
    minute(),
  ));
  // Tasks in the order the sidebar shows them; folded quiet tasks get no shortcut.
  const orderedTasks = createMemo(() => sidebarView() === 'recent'
    ? recentView().recent.map(r => r.task)
    : visibleProjects(projects).flatMap(p => activeTasksByProject()[p.id] || []));

  const taskBindingById = createMemo(() => {
    const map: Record<string, number | null> = {}
    orderedTasks().forEach((t, idx) => { map[t.id] = idx < 9 ? idx : null })
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

  // Load sessions + git state only for tasks that are newly in the list. A
  // prior version re-fired the whole loop on any length change, which made a
  // single task insert spawn ~10 git subprocesses per existing task in
  // parallel — enough to exhaust the macOS 256 FD ceiling while
  // `ipc.createTask` was trying to spawn its own `git check-ref-format`.
  createEffect(
    on(
      () => tasks.map(t => t.id),
      (currIds, prevIds) => {
        for (const id of newTaskIds(prevIds, currIds)) {
          loadSessions(id);
          refreshTaskGit(id);
        }
      },
    ),
  );

  // Watch only worktrees on screen: the selected task and tasks open in their
  // own window. Others refresh git on session turn end (see worktreeWatch).
  createEffect(() => {
    const ids = tasks.filter(t => isTaskWindowed(t.id)).map(t => t.id);
    const selected = selectedTaskId();
    if (selected) ids.push(selected);
    syncWatchedWorktrees(ids);
  });


  const showProjectMenu = (e: MouseEvent, projectId: string) => {
    e.preventDefault();
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    setContextMenu({
      pos: { x: e.clientX, y: e.clientY },
      items: [
        { label: 'Move to group…', action: () => { setMoveTarget(projectGroup(projectId)); setGroupError(''); setMovingProject(projectId); } },

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
    const project = projectById(task.projectId);
    const handleStart = async () => {
      const cmd = project?.startCommand;
      if (!cmd) return;
      if (selectedTaskId() === task.id) setShowTerminal(true);
      await spawnStartCommand(task.id, cmd);
    };
    const openProjectSettings = () => {
      selectSettingsSection(task.projectId);
      setShowSettings(true);
    };
    setContextMenu({
      pos: { x: e.clientX, y: e.clientY },
      items: buildTaskMenuItems(
        {
          onOpenInNewWindow: () => ipc.openTaskWindow(task.id, task.name || undefined),
          onRename: () => setRenamingTaskId(taskId),
          onOpenInFinder: () => ipc.openInFinder(task.worktreePath),
          onStartApp: handleStart,
          onStopApp: () => stopStartCommand(task.id),
          onSetupStartCommand: openProjectSettings,
          onArchive: () => setArchiveTaskTarget(taskId),
        },
        {
          isRunning: isStartCommandRunning(task.id),
          isSetupRunning: isSetupRunning(task.id),
          hasStartCommand: !!project?.startCommand,
        },
      ),
    });
  };

  const closeMenu = () => setContextMenu(null);

  // One task row, shared by the project and recent views. `meta` turns it into
  // a two-line tile: the title keeps the full width, project and age go below.
  const renderTaskRow = (task: Task, meta?: () => JSX.Element) => {
    const status = () => taskStatus(task.id);
    const creating = () => isTaskCreating(task.id);
    const archiving = () => isTaskArchiving(task.id);
    const hasError = () => !!getTaskError(task.id);
    const unread = () => isTaskUnread(task.id);
    const disabled = () => creating() || archiving();
    const windowed = () => isTaskWindowed(task.id);
    const bindingIdx = () => taskBindingIndex(task.id);
    const cloudPhase = () => getCloudTaskPhase(task.id);

    const handleClick = () => focusOrSelectTask(task);

    const isSelected = () => !windowed() && selectedTaskId() === task.id;
    // The shortcut and archive button sit on the meta line in a tile, beside
    // the title in a plain row.
    const trailing = meta ? 'bottom-[3px]' : 'top-1/2 -translate-y-1/2';
    const tooltip = () => windowed() ? 'Open in separate window — click to focus'
      : `${task.name || 'New task'}\n${task.branch} · ${hasError() ? 'Setup failed' : cloudPhase() ?? status().label}`;

    return (
      <div
        class={clsx(
          "group/task relative pl-2 pr-2 py-1.5 rounded-md flex gap-2 cursor-pointer",
          meta ? "items-start" : "items-center",
          isSelected()
            ? "bg-surface-2"
            : "hover:bg-surface-2",
          archiving() && "opacity-50 pointer-events-none",
          windowed() && "opacity-60",
        )}
        style={isSelected() ? { 'box-shadow': 'inset 2px 0 0 rgb(var(--accent-rgb))' } : undefined}
        onClick={handleClick}
        onDblClick={() => { if (!disabled() && !hasError()) ipc.openTaskWindow(task.id, task.name || undefined) }}
        onContextMenu={(e) => { if (!disabled() && !hasError()) showTaskMenu(e, task.id) }}
        title={tooltip()}
      >
        <span class={clsx("shrink-0 flex", meta && "h-4 items-center")}>
          <TaskStatusIcon kind={hasError() ? 'failed' : status().kind} label={hasError() ? 'Setup failed' : status().label} />
        </span>
        <div class="flex-1 min-w-0 flex flex-col gap-0.5">
        <div class={clsx("min-w-0 flex items-center gap-1.5", meta ? "h-4" : bindingIdx() !== null && "pr-5")}>
          <Show when={renamingTaskId() === task.id} fallback={
            <span class={clsx(
              "text-xs truncate",
              unread() || isSelected() ? "text-text-primary font-medium" : "text-text-secondary"
            )}>
              {task.name || "New task"}
            </span>
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
          <Show when={task.parentTaskId}>
            <GitBranch size={10} class="shrink-0 text-text-dim" aria-label="Forked task" />
          </Show>
          <Show when={isStartCommandRunning(task.id)}>
            <span class="shrink-0 flex items-center gap-0.5 px-1 rounded text-[9px] leading-[14px] text-text-muted ring-1 ring-outline/10" title="App running">
              <Play size={7} class="fill-current" />app
            </span>
          </Show>
          <Show when={windowed()}>
            <ExternalLink size={10} class="shrink-0 text-text-dim" aria-label="Open in separate window" />
          </Show>
          <Show when={cloudPhase()}>
            <span class="text-[10px] text-text-dim truncate">{cloudPhase()}</span>
          </Show>
        </div>
        <Show when={meta}>
          <span class="min-w-0 h-3.5 pr-7 flex items-center gap-1.5 text-[10px] text-text-dim">{meta!()}</span>
        </Show>
        </div>
        <Show when={hasError() && getCloudTaskPhase(task.id)}>
          <button class="btn-ghost text-xs" onClick={e => { e.stopPropagation(); retryCloudTaskImport(task.id) }}>Retry</button>
        </Show>
        <Show when={!archiving() && !getCloudTaskPhase(task.id)}>
          <Show when={bindingIdx() !== null}>
            <kbd class={`absolute right-2 ${trailing} h-5 flex items-center leading-none text-[10px] font-mono text-text-dim pointer-events-none group-hover/task:opacity-0 transition-opacity`}>
              {'\u2318'}{bindingIdx()! + 1}
            </kbd>
          </Show>
          <button
            class={`absolute right-2 ${trailing} w-5 h-5 flex items-center justify-center rounded opacity-0 group-hover/task:opacity-100 text-text-dim hover:text-text-muted bg-surface-2`}
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
  };

  return (
    <>
      {/* Context menu */}
      <ContextMenu
        open={!!contextMenu()}
        onClose={closeMenu}
        pos={contextMenu()?.pos}
        items={contextMenu()?.items || []}
      />

      <Dialog open={!!movingProject()} onClose={() => setMovingProject(null)}>
        <h2 class="text-sm font-semibold text-text-primary mb-3">Move {projectById(movingProject() ?? '')?.name} to group</h2>
        <Select label="Destination group" value={moveTarget()} onChange={setMoveTarget} options={[
          { value: 'ungrouped', label: 'Ungrouped' }, ...groupState().groups.map(g => ({ value: g.id, label: g.name }))
        ]} />
        <Show when={groupError()}><p role="alert" class="text-xs text-status-error mt-2">{groupError()}</p></Show>
        <div class="flex justify-end gap-2 mt-4">
          <button class="btn-ghost" onClick={() => setMovingProject(null)}>Cancel</button>
          <button class="btn-primary" onClick={() => {
            try { moveProject(movingProject()!, moveTarget()); setMovingProject(null); }
            catch (e) { setGroupError(String(e).replace(/^Error: /, '')); }
          }}>Move</button>
        </div>
      </Dialog>

      <div class="h-full bg-surface-1 flex flex-col overflow-hidden">
        {/* Header — also serves as titlebar drag region */}
        <div class="px-2 pt-10 pb-1.5 flex items-center gap-1 drag-region" data-tauri-drag-region>
          <button type="button" class="flex-1 min-w-0 px-2 py-1.5 flex items-center gap-2 rounded-md text-xs text-text-secondary hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent no-drag" classList={{ 'bg-surface-3 text-text-primary': showTaskBoard() }} aria-pressed={showTaskBoard()} onClick={openTaskBoard}>
            <Columns3 size={14} class="shrink-0" /><span class="flex-1 text-left">Task board</span>
            <Show when={needsYouTasks().length > 0}>
              <span class="flex items-center gap-1 text-[11px] font-medium tabular-nums text-status-waiting" title={`${needsYouTasks().length} need you`}>
                <TaskStatusIcon kind="input" size={11} label="Need you" />{needsYouTasks().length}
              </span>
            </Show>
            <Show when={floor().running > 0}>
              <span class="flex items-center gap-1 text-[11px] tabular-nums text-text-dim" title={`${floor().running} running`}>
                <LoaderCircle size={11} class="animate-spin" />{floor().running}
              </span>
            </Show>
          </button>
          <button
            class="p-1.5 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors no-drag"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setContextMenu({
                pos: { x: rect.left, y: rect.bottom + 4 },
                items: buildAddProjectMenuItems({
                  onAddExisting: async () => {
                    const selected = await openDialog({ directory: true, multiple: false });
                    if (selected) setAddProjectPath(selected as string);
                  },
                  onCreateNew: () => setShowBtsBuilder(true),
                  onCloneRepo: () => setShowCloneRepo(true),
                  onQuickTask: () => { void openQuickTask() },
                }),
              });
            }}
            title="Add Project (⌘O)"
            aria-label="Add project"
          >
            <Plus size={14} />
          </button>
        </div>

        <GroupToolbar attention={otherAttention()} onAttention={jumpToAttention} />
        {/* Project + task list */}
        <div class="flex-1 overflow-y-auto overflow-x-hidden px-2 no-drag">
          <Show when={!projectQuery().trim() && (needsYouTasks().length > 0 || unknownCount() > 0)}>
            <section aria-label="Needs you" class="mb-2 pb-2 border-b-1 border-b-solid border-b-outline/8">
              <button type="button" class="w-full px-2 py-1 flex items-center gap-1.5 rounded text-[11px] font-semibold text-status-waiting hover:bg-surface-2"
                aria-expanded={!queueCollapsed()} onClick={() => setQueueCollapsed(!queueCollapsed())}>
                <Show when={queueCollapsed()} fallback={<ChevronDown size={12} />}><ChevronRight size={12} /></Show>
                <span class="flex-1 text-left">Needs you</span>
                <span class="tabular-nums">{needsYouTasks().length}</span>
              </button>
              <Show when={!queueCollapsed()}>
                <div>
                  <For each={needsYouTasks()}>{(task) => {
                    const status = () => taskStatus(task.id);
                    return (
                      <button type="button" class="w-full pl-2 pr-2 py-1.5 flex items-center gap-2 text-left rounded-md hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent"
                        classList={{ 'bg-surface-2': selectedTaskId() === task.id }}
                        title={`${task.name || 'New task'}\n${projectById(task.projectId)?.name ?? ''} · ${status().label}`}
                        onClick={() => { revealProject(task.projectId); focusOrSelectTask(task); }}>
                        <TaskStatusIcon kind={status().kind} label={status().label} />
                        <span class="flex-1 min-w-0 text-xs text-text-primary truncate">{task.name || 'New task'}</span>
                        <span class={clsx('shrink-0 text-[10px] font-medium', status().kind === 'input' ? 'text-status-waiting' : 'text-status-error')}>{status().label}</span>
                      </button>
                    );
                  }}</For>
                  <Show when={unknownCount() > 0}>
                    <button type="button" class="w-full pl-2 pr-2 py-1.5 flex items-center gap-2 text-left rounded-md text-[11px] text-text-muted hover:bg-surface-2 hover:text-text-primary"
                      title="Claude's status can't be read for these tasks, so they may be waiting on you. Open the board to check them."
                      onClick={openTaskBoard}>
                      <TaskStatusIcon kind="unknown" label="Status unavailable" />
                      <span class="flex-1">{unknownCount()} with unknown status</span>
                    </button>
                  </Show>
                </div>
              </Show>
            </section>
          </Show>
          <Show when={!projectQuery().trim() && sidebarView() === 'recent'}>
            <RecentTaskList recent={recentView().recent} quiet={recentView().quiet} row={r => renderTaskRow(r.task, () => <>
              <span class="truncate">{projectById(r.task.projectId)?.name}</span>
              <span aria-hidden="true" class="shrink-0">·</span>
              <span class="tabular-nums shrink-0">{formatAgo(r.lastActive, minute())}</span>
            </>)} />
          </Show>
          <Show when={projectQuery().trim()}>
            <p class="text-[10px] text-text-dim px-2 py-1">Results from all groups</p>
            <For each={visibleProjects(projects)}>{project => <button class="w-full px-2 py-2 text-left rounded-md hover:bg-surface-2" onClick={() => reveal(project.id)}>
              <span class="block text-xs text-text-primary truncate">{project.name}</span>
              <span class="block text-[10px] text-text-dim">{groupName(projectGroup(project.id))}</span>
            </button>}</For>
            <Show when={visibleProjects(projects).length === 0}><p class="text-xs text-text-muted p-2">No matching projects.</p></Show>
          </Show>
          <Show when={!projectQuery().trim() && sidebarView() === 'projects'}>
          <For each={sections()}>{section => <div>
            <Show when={groupState().scope === 'all' && groupState().groups.length > 0}>
              <GroupHeading id={section.id} name={section.name} count={section.projects.length} attention={attentionTasks(section.id).length} />
            </Show>
            <Show when={!section.collapsed}>
              <Show when={section.projects.length === 0}><p class="px-2 py-2 text-[11px] text-text-dim">No projects yet. Right-click a project to move it here.</p></Show>
          <For each={section.projects}>
            {(project) => (
              <div class="mb-2">
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
                    <span class="text-[11px] font-semibold text-text-primary truncate">
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
                      {(task) => renderTaskRow(task)}
                    </For>
                  </div>
                </Show>

              </div>
            )}
          </For>
            </Show>
          </div>}</For>
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
          <StatusKey />
          <div class="ml-auto"><KeepAwakeButton /></div>
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


    </>
  );
};
