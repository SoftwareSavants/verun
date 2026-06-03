import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import {
  GitFork,
  Lock,
  Loader2,
  Archive,
  Search,
  Star,
  Copy,
  Check,
  Building2,
  Command,
  CornerDownLeft,
} from "lucide-solid";
import { PathAutocomplete } from "./PathAutocomplete";

const PARENT_DIR_KEY = "verun.clone.parentDir";

// Extract `owner/repo` from a slug, HTTPS, or SSH GitHub URL. Returns null if
// the input isn't a recognizable GitHub repo reference.
const extractOwnerRepo = (raw: string): string | null => {
  const s = raw.trim().replace(/\.git$/, "");
  if (!s) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return s;
  const ssh = s.match(/^git@[^:]+:([\w.-]+\/[\w.-]+)$/);
  if (ssh) return ssh[1];
  try {
    const u = new URL(s);
    const parts = u.pathname.replace(/^\//, "").split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  } catch {
    /* not a URL */
  }
  return null;
};

// Extract an owner from a GitHub *profile* URL like
// `https://github.com/SoftwareSavants` — i.e. exactly one path segment, no
// repo half. Returns null for non-GitHub URLs, repo URLs (handled by
// `extractOwnerRepo`), or non-URL strings.
const extractGithubOwnerProfile = (raw: string): string | null => {
  const s = raw.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.replace(/^\//, "").split("/").filter(Boolean);
  if (parts.length !== 1) return null;
  if (!/^[\w][\w-]*$/.test(parts[0])) return null;
  return parts[0];
};

const CommandBlock = (props: { command: string }) => {
  const [copied, setCopied] = createSignal(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      addToast(`Copy failed: ${e}`, "error");
    }
  };
  return (
    <div class="relative">
      <pre class="bg-surface-3 rounded-lg p-2 pr-9 text-[11px] font-mono text-text-primary whitespace-pre">
        {props.command}
      </pre>
      <button
        type="button"
        class="absolute top-1.5 right-1.5 p-1 rounded-lg text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
        onClick={() => void handleCopy()}
        title={copied() ? "Copied!" : "Copy to clipboard"}
        aria-label="Copy command"
      >
        <Show when={copied()} fallback={<Copy size={12} />}>
          <Check size={12} class="text-status-done" />
        </Show>
      </button>
    </div>
  );
};

import { Dialog } from "./Dialog";
import {
  addToast,
  dismissToast,
  setSelectedProjectId,
  setSetupProject,
} from "../store/ui";
import { setProjects } from "../store/projects";
import { produce } from "solid-js/store";
import * as ipc from "../lib/ipc";
import type { GhStatus, RemoteRepo } from "../types";
import { clsx } from "clsx";

interface Props {
  open: boolean;
  onClose: () => void;
}

type View =
  | { kind: "checking" }
  | { kind: "needs-install" }
  | { kind: "needs-auth" }
  | { kind: "offline" }
  | { kind: "error"; message: string }
  | { kind: "ready"; repos: RemoteRepo[]; account: string | null };

// GitHub avatar URLs accept an `s` (pixels) query param. Request 2× the
// rendered size so the image stays crisp on retina displays instead of
// upscaling a tiny default thumbnail.
const sizedAvatar = (url: string, px: number): string => {
  try {
    const u = new URL(url);
    u.searchParams.set("s", String(px * 2));
    return u.toString();
  } catch {
    return url;
  }
};

export const CloneRepoDialog: Component<Props> = (props) => {
  const [view, setView] = createSignal<View>({ kind: "checking" });
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [selectedRepo, setSelectedRepo] = createSignal<RemoteRepo | null>(null);
  const [parentDir, setParentDir] = createSignal(
    localStorage.getItem(PARENT_DIR_KEY) ?? "",
  );
  const [remoteResults, setRemoteResults] = createSignal<RemoteRepo[]>([]);
  const [remoteLoading, setRemoteLoading] = createSignal(false);

  let listRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;

  const refresh = async () => {
    setView({ kind: "checking" });
    try {
      const status: GhStatus = await ipc.ghStatus();
      if (!status.installed) {
        setView({ kind: "needs-install" });
        return;
      }
      // Offline is checked *before* `authenticated` so we don't tell the
      // user to run `gh auth login` when their wifi is down.
      if (status.offline) {
        setView({ kind: "offline" });
        return;
      }
      if (!status.authenticated) {
        setView({ kind: "needs-auth" });
        return;
      }
      const repos = await ipc.listUserGithubRepos();
      setView({ kind: "ready", repos, account: status.account });
    } catch (e) {
      // `gh api /user/repos` failing with a network error is the same as
      // being offline at startup — surface the offline view rather than a
      // wall of "fetch failed" text.
      const msg = String(e).toLowerCase();
      if (
        /no such host|could not resolve|dial tcp|connection refused|i\/o timeout|network is unreachable/.test(
          msg,
        )
      ) {
        setView({ kind: "offline" });
      } else {
        setView({ kind: "error", message: String(e) });
      }
    }
  };

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) {
          setQuery("");
          setSelectedIndex(0);
          setSelectedRepo(null);
          void refresh();
        }
      },
    ),
  );

  // Score a repo against a list of tokens. Returns -1 if any token fails to
  // match anywhere. Higher = better. Priorities, per token:
  //   exact repo-name match > repo-name prefix > repo-name substring >
  //   owner exact > owner prefix > owner substring > description substring.
  const scoreRepo = (repo: RemoteRepo, tokens: string[]): number => {
    const full = repo.nameWithOwner.toLowerCase();
    const slash = full.indexOf("/");
    const owner = slash >= 0 ? full.slice(0, slash) : full;
    const name = slash >= 0 ? full.slice(slash + 1) : "";
    const desc = (repo.description ?? "").toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (!t) continue;
      if (name === t) score += 100;
      else if (name.startsWith(t)) score += 50;
      else if (name.includes(t)) score += 25;
      else if (owner === t) score += 30;
      else if (owner.startsWith(t)) score += 15;
      else if (owner.includes(t)) score += 10;
      else if (desc.includes(t)) score += 2;
      else return -1;
    }
    return score;
  };

  const filtered = createMemo<RemoteRepo[]>(() => {
    const v = view();
    if (v.kind !== "ready") return [];
    const q = query().trim().toLowerCase();
    if (!q) return v.repos;
    // If the user pasted (or we just stuffed in) a URL/slug like
    // `https://github.com/owner/repo`, fold it to `owner/repo` before
    // tokenizing so the filter still narrows to that repo.
    const slug = extractOwnerRepo(q);
    const tokens = (slug ?? q).split(/[\s/]+/).filter(Boolean);
    const localScored = v.repos
      .map((r) => ({ r, s: scoreRepo(r, tokens) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.r);
    // Merge in remote (public) results, deduped by slug. Local first so the
    // user's own repos always rank above public matches.
    const seen = new Set(localScored.map((r) => r.nameWithOwner.toLowerCase()));
    const merged = [...localScored];
    for (const r of remoteResults()) {
      const key = r.nameWithOwner.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(r);
      }
    }
    // Always keep the picked repo visible — if the user selected a public
    // hit and we then cleared `remoteResults` (suppressing the redundant
    // fetch for the stamped URL), the row would otherwise disappear and the
    // list would show the empty "No repos match" state.
    const picked = selectedRepo();
    if (picked && !seen.has(picked.nameWithOwner.toLowerCase())) {
      merged.unshift(picked);
    }
    return merged;
  });

  // Debounced remote lookup. When the query looks like a GitHub URL/slug we
  // fetch that single repo (so a pasted URL surfaces as an actionable row);
  // otherwise we hit GitHub's public search after a short idle period so
  // typing doesn't fire a request per keystroke.
  let searchTimer: number | undefined;
  createEffect(
    on(query, (q) => {
      if (searchTimer !== undefined) {
        clearTimeout(searchTimer);
        searchTimer = undefined;
      }
      const trimmed = q.trim();
      if (!trimmed) {
        setRemoteResults([]);
        setRemoteLoading(false);
        return;
      }
      // If the query was stamped in by selecting a repo from the list (URL or
      // slug matches the picked repo), skip the remote roundtrip — we already
      // have everything we need and don't want a stray "Loading…" flicker.
      const picked = selectedRepo();
      if (
        picked &&
        (trimmed === picked.url || trimmed === picked.nameWithOwner)
      ) {
        setRemoteResults([]);
        setRemoteLoading(false);
        return;
      }
      const slug = extractOwnerRepo(trimmed);
      setRemoteLoading(true);
      searchTimer = window.setTimeout(
        async () => {
          // Lookup strategy — GitHub's search API is case-insensitive across
          // all qualifiers, so we pass the user's input through as-is:
          //
          //   • Slug-shaped input (`owner/repo`, full URL, or `owner/partial`):
          //     fire the canonical fetch *and* a keyword search restricted to
          //     that owner via `<name-part> user:<owner>` — narrower than a
          //     global keyword search and surfaces partial-name matches
          //     within an org. The exact fetch still gives us full metadata
          //     for a complete slug (or a pasted URL); for an incomplete
          //     tail like `openclaw/o` it 404s but the search rescues it.
          //   • Anything else (one token, free text): a plain keyword
          //     search across all of GitHub.
          //
          // Either branch failing doesn't tank the lookup — `allSettled`
          // lets the survivor populate the list.
          try {
            const fresh = () => query().trim() === trimmed;
            let next: RemoteRepo[] = [];
            if (slug) {
              const [owner, ...rest] = slug.split("/");
              const namePart = rest.join("/").trim();
              const keyword = namePart
                ? `${namePart} user:${owner}`
                : `user:${owner}`;
              const [exact, fuzzy] = await Promise.allSettled([
                ipc.fetchGithubRepo(slug),
                ipc.searchGithubRepos(keyword),
              ]);
              // Exact-fetch success means the user typed (or pasted) the
              // canonical slug/URL of a real repo — show only that one. We
              // only fall back to the fuzzy `user:<owner>` search when the
              // fetch 404'd (incomplete tails like `openclaw/o`).
              if (exact.status === "fulfilled") {
                next.push(exact.value);
              } else if (fuzzy.status === "fulfilled") {
                next = fuzzy.value;
              }
            } else {
              // Owner-only GitHub profile URL — list every repo owned by
              // that account via the `user:` qualifier.
              const ownerProfile = extractGithubOwnerProfile(trimmed);
              const searchQuery = ownerProfile
                ? `user:${ownerProfile}`
                : trimmed;
              next = await ipc.searchGithubRepos(searchQuery);
            }
            if (fresh()) setRemoteResults(next);
          } catch {
            if (query().trim() === trimmed) setRemoteResults([]);
          } finally {
            if (query().trim() === trimmed) setRemoteLoading(false);
          }
        },
        // Short debounce — long enough to avoid firing per keystroke, short
        // enough that pausing for a heartbeat feels instant. The slug path
        // is slightly snappier since exact-fetch + restricted search are
        // cheaper than a global keyword search.
        slug ? 80 : 120,
      );
    }),
  );
  onCleanup(() => {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
  });

  // Focus the search input as soon as the ready view mounts. Solid's
  // `autofocus` attribute is unreliable inside a portal-mounted modal — the
  // input element exists for ~1 frame before the dialog finishes its enter
  // animation, so the browser drops the implicit focus. Re-asserting via the
  // ref after the view flips guarantees the user can type immediately.
  createEffect(
    on(
      () => view().kind,
      (kind) => {
        if (kind === "ready") {
          queueMicrotask(() => searchInputRef?.focus());
        }
      },
    ),
  );

  createEffect(on(query, () => setSelectedIndex(0)));
  // Clear the picked repo when the user edits the input away from it. Without
  // this, typing past the auto-filled URL would leave a stale selection that
  // doesn't match what's in the search box.
  createEffect(
    on(query, (q) => {
      const repo = selectedRepo();
      if (!repo) return;
      if (q !== repo.url && q !== repo.nameWithOwner) {
        setSelectedRepo(null);
      }
    }),
  );
  createEffect(
    on(selectedIndex, (idx) => {
      if (!listRef) return;
      const item = listRef.querySelectorAll("button[data-repo]")[idx] as
        | HTMLElement
        | undefined;
      item?.scrollIntoView({ block: "nearest" });
    }),
  );

  const ensureParentDir = (): string | null => {
    const p = parentDir().trim();
    if (!p) {
      addToast("Choose a destination folder first", "error");
      return null;
    }
    localStorage.setItem(PARENT_DIR_KEY, p);
    return p;
  };

  const canClone = createMemo(() => {
    if (!parentDir().trim()) return false;
    // Only allow cloning a repo the user explicitly picked from the list.
    // A URL-shaped query without a matching row most likely means the repo
    // doesn't exist or is private — attempting `git clone` would fail with
    // the same error message we'd otherwise need to translate.
    return selectedRepo() !== null;
  });

  // Clicking "Clone Repo" closes the dialog immediately and runs the clone
  // in the background; a persistent progress toast (VS Code-style — title +
  // URL + "Source: Git" + indeterminate progress bar with a Cancel button)
  // tracks the operation and is swapped in place for a success/error toast
  // when the IPC settles. Cancel just dismisses the toast — git keeps
  // running in the background since we don't track the child process yet.
  const startClone = () => {
    if (!canClone()) return;
    const parent = ensureParentDir();
    if (!parent) return;
    const repo = selectedRepo();
    if (!repo) return;
    const args = { nameWithOwner: repo.nameWithOwner, parentDir: parent };
    const cloneUrl = `https://github.com/${repo.nameWithOwner}.git`;
    const toastId = `clone:${repo.nameWithOwner}`;
    addToast(cloneUrl, "info", {
      id: toastId,
      title: "Cloning git repository",
      meta: "Source: Git",
      progress: true,
      persistent: true,
      actions: [
        {
          label: "Cancel",
          variant: "ghost",
          onClick: () => dismissToast(toastId),
        },
      ],
    });
    props.onClose();
    void (async () => {
      try {
        const project = await ipc.cloneGithubRepoAndAdd(args);
        setProjects(produce((p) => p.push(project)));
        setSelectedProjectId(project.id);
        addToast(`Cloned ${project.name}`, "success", { id: toastId });
        // Mirror the "added a project from disk" flow — open the setup
        // dialog so the user can configure hooks / auto-detect before
        // running their first task.
        setSetupProject(project);
      } catch (e) {
        addToast(`Clone failed: ${e}`, "error", { id: toastId });
      }
    })();
  };

  const handleListKeyDown = (e: KeyboardEvent) => {
    const items = filtered();
    switch (e.key) {
      case "ArrowDown":
        if (items.length > 0) {
          e.preventDefault();
          setSelectedIndex((i) => (i + 1) % items.length);
        }
        break;
      case "ArrowUp":
        if (items.length > 0) {
          e.preventDefault();
          setSelectedIndex((i) => (i - 1 + items.length) % items.length);
        }
        break;
      case "Enter":
        // ⌘+Enter (or Ctrl+Enter on non-Mac) is the documented shortcut for
        // "Clone": fires only when the gate is satisfied, regardless of
        // whether a row is highlighted.
        if ((e.metaKey || e.ctrlKey) && canClone()) {
          e.preventDefault();
          startClone();
        } else if (items.length > 0) {
          e.preventDefault();
          pickRepo(items[selectedIndex()]);
        }
        break;
    }
  };

  // Global ⌘/Ctrl+Enter shortcut — works regardless of which input is
  // focused (search box, destination autocomplete, or just the dialog body).
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
          if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
          if (!canClone()) return;
          e.preventDefault();
          startClone();
        };
        window.addEventListener("keydown", handler);
        onCleanup(() => window.removeEventListener("keydown", handler));
      },
    ),
  );

  // Selecting a repo also stamps its clone URL into the search input so the
  // user has a clear visual record of what's about to be cloned (and can
  // paste it elsewhere if needed). The URL-aware filter keeps the list
  // narrowed to this repo afterward.
  const pickRepo = (repo: RemoteRepo) => {
    // Toggle: clicking the already-picked repo deselects it and clears the
    // stamped URL, so the user can back out without typing.
    if (selectedRepo()?.nameWithOwner === repo.nameWithOwner) {
      setSelectedRepo(null);
      setQuery("");
      return;
    }
    setSelectedRepo(repo);
    setQuery(repo.url);
  };

  // Reset on close
  onCleanup(() => {
    setView({ kind: "checking" });
  });

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="34rem"
      class="!p-4 !border-border-active !shadow-[0_16px_50px_-12px_rgba(0,0,0,0.55)] !overflow-visible"
    >
      <div class="flex flex-col gap-5">
        <div class="flex items-start justify-between">
          <h2 class="m-0 text-[13px] font-semibold leading-tight text-text-primary">
            Clone GitHub repo
          </h2>
          <Show
            when={
              view().kind === "ready" &&
              (view() as { account: string | null }).account
            }
          >
            {(account) => (
              <span class="text-[11px] text-text-dim">@{account()}</span>
            )}
          </Show>
        </div>

        <Show when={view().kind === "checking"}>
          <div class="py-3 flex items-center justify-center text-text-dim text-xs gap-2">
            <Loader2 size={14} class="animate-spin" />
            Checking GitHub ...
          </div>
        </Show>

        <Show when={view().kind === "needs-install"}>
          <div class="space-y-3 text-xs text-text-secondary">
            <p>
              The GitHub CLI (<code class="text-accent">gh</code>) isn't
              installed or isn't on your PATH.
            </p>
            <CommandBlock command={"brew install gh\ngh auth login"} />
            <p class="text-text-dim">After installing, click Retry.</p>
            <button
              class="btn-primary text-xs px-3 py-1.5"
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </div>
        </Show>

        <Show when={view().kind === "needs-auth"}>
          <div class="space-y-3 text-xs text-text-secondary">
            <p>The GitHub CLI is installed but not signed in.</p>
            <CommandBlock command="gh auth login" />
            <button
              class="btn-primary text-xs px-3 py-1.5"
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </div>
        </Show>

        <Show when={view().kind === "offline"}>
          <div class="space-y-3 text-xs text-text-secondary">
            <p class="text-status-error">No internet connection.</p>
            <p class="text-text-dim">
              Verun couldn't reach GitHub to load your repositories. Check your
              network and try again.
            </p>
            <button
              class="btn-primary text-xs px-3 py-1.5"
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </div>
        </Show>

        <Show when={view().kind === "error"}>
          {(_) => {
            const v = view() as { kind: "error"; message: string };
            return (
              <div class="space-y-3 text-xs">
                <p class="text-red-400">{v.message}</p>
                <button
                  class="btn-primary text-xs px-3 py-1.5"
                  onClick={() => void refresh()}
                >
                  Retry
                </button>
              </div>
            );
          }}
        </Show>

        <Show when={view().kind === "ready"}>
          <div class="flex flex-col gap-5">
            <div class="relative">
              <Search
                size={15}
                class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-dim"
              />
              <input
                ref={searchInputRef}
                type="text"
                autofocus
                placeholder="Search your repos, all of GitHub, or paste a URL..."
                class="w-full rounded-lg bg-surface-3 py-2.5 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-60"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={handleListKeyDown}
              />
            </div>

            <div
              ref={listRef}
              class="max-h-[40vh] overflow-y-auto rounded-lg bg-surface-1 p-2 ring-1 ring-border-active"
            >
              <Show
                when={filtered().length > 0 || remoteLoading()}
                fallback={
                  <div class="space-y-1 py-3 text-center text-[11px] text-text-dim">
                    <div>
                      No repo matches{" "}
                      <span class="font-mono text-text-secondary">
                        {query().trim()}
                      </span>
                    </div>
                    <div>The repo may not exist — try a different search.</div>
                  </div>
                }
              >
                <div class="space-y-0.5">
                  <For each={filtered()}>
                    {(repo, i) => {
                      const isPicked = createMemo(
                        () =>
                          selectedRepo()?.nameWithOwner === repo.nameWithOwner,
                      );
                      return (
                        <button
                          data-repo
                          class={clsx(
                            "flex w-full items-center gap-4 rounded p-2 text-left transition-colors",
                            isPicked()
                              ? "bg-surface-2/70 text-text-primary"
                              : selectedIndex() === i()
                                ? "bg-surface-3 text-text-primary"
                                : "text-text-secondary hover:bg-surface-2/70",
                          )}
                          onMouseEnter={() => setSelectedIndex(i())}
                          onClick={() => pickRepo(repo)}
                        >
                          <Show
                            when={repo.ownerAvatarUrl}
                            fallback={
                              <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm ring-1 ring-outline/10 bg-surface-3 text-text-muted">
                                <Building2 size={16} />
                              </span>
                            }
                          >
                            {(src) => (
                              <img
                                src={sizedAvatar(src(), 24)}
                                alt=""
                                width={24}
                                height={24}
                                class="h-6 w-6 shrink-0 rounded-sm object-cover ring-1 ring-outline/10"
                              />
                            )}
                          </Show>
                          <div class="min-w-0 flex-1">
                            <div class="flex min-w-0 items-center gap-2">
                              <span class="truncate text-[13px] font-medium text-text-primary">
                                {repo.nameWithOwner}
                              </span>
                              <Show when={repo.isPrivate}>
                                <Lock
                                  size={11}
                                  class="shrink-0 text-text-dim"
                                />
                              </Show>
                              <Show when={repo.isFork}>
                                <GitFork
                                  size={11}
                                  class="shrink-0 text-text-dim"
                                />
                              </Show>
                              <Show when={repo.isArchived}>
                                <Archive
                                  size={11}
                                  class="shrink-0 text-text-dim"
                                />
                              </Show>
                              <Show when={isPicked()}>
                                <Check size={12} class="shrink-0 text-accent" />
                              </Show>
                              <Show when={repo.starCount > 0}>
                                <span class="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-text-dim">
                                  <Star size={11} />
                                  {repo.starCount}
                                </span>
                              </Show>
                            </div>
                            <Show
                              when={repo.description}
                              fallback={
                                <div class="mt-0.5 truncate font-mono text-[11px] text-text-dim/80">
                                  {repo.url}
                                </div>
                              }
                            >
                              <div class="mt-0.5 truncate text-[12px] text-text-muted">
                                {repo.description}
                              </div>
                            </Show>
                          </div>
                        </button>
                      );
                    }}
                  </For>
                  <Show when={remoteLoading()}>
                    <For each={[0, 1, 2]}>
                      {() => (
                        <div
                          data-shimmer
                          class="flex w-full items-center gap-4 rounded p-2"
                          aria-hidden="true"
                        >
                          <div class="h-6 w-6 shrink-0 animate-pulse rounded-sm bg-surface-3" />
                          <div class="min-w-0 flex-1 space-y-1.5">
                            <div class="h-3 w-2/5 animate-pulse rounded bg-surface-3" />
                            <div class="h-2.5 w-3/4 animate-pulse rounded bg-surface-3/70" />
                          </div>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </Show>
            </div>

            <div>
              <label class="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-text-dim">
                Destination folder
              </label>
              <PathAutocomplete
                value={parentDir()}
                onChange={setParentDir}
                placeholder="~"
              />
            </div>

            <div class="flex items-center gap-5 text-[11px] text-text-dim">
              <span class="flex items-center gap-1.5">
                <span class="flex items-center gap-0.5">
                  <kbd class="rounded-lg bg-surface-3 px-1 py-0.5 font-mono text-text-muted">
                    ↑
                  </kbd>
                  <kbd class="rounded-lg bg-surface-3 px-1 py-0.5 font-mono text-text-muted">
                    ↓
                  </kbd>
                </span>
                Navigate
              </span>
              <span class="flex items-center gap-1.5">
                <kbd class="rounded-lg bg-surface-3 px-1 py-0.5 font-mono text-text-muted">
                  Enter
                </kbd>
                Select
              </span>
              <span class="flex items-center gap-1.5">
                <kbd class="rounded-lg bg-surface-3 px-1 py-0.5 font-mono text-text-muted">
                  Esc
                </kbd>
                Close
              </span>
              <button
                type="button"
                class={clsx(
                  "ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  canClone()
                    ? "bg-accent text-white hover:bg-accent/90"
                    : "bg-surface-3 text-text-dim cursor-not-allowed",
                )}
                disabled={!canClone()}
                onClick={() => startClone()}
              >
                Clone Repo
                <span class="ml-1 flex items-center gap-0.5">
                  <Command size={12} />
                  <CornerDownLeft size={12} />
                </span>
              </button>
            </div>
          </div>
        </Show>
      </div>
    </Dialog>
  );
};
