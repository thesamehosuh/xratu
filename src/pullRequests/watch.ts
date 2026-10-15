// Adapted from T3 Code ec80933ac8, MIT, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.txt. Keep event semantics aligned with the donor tests.
import type { PullRequestCheck, PullRequestComment, PullRequestSnapshot, PullRequestWatch } from './types';

/**
 * Wakes in a row that bring only comments. Check, conflict, or push news resets the count, so
 * this only stops a chatty bot looping an agent that is replying to it.
 */
export const PULL_REQUEST_WATCH_WAKE_LIMIT = 10;

export type PullRequestWatchChange =
  | { readonly kind: "checks-failed"; readonly failed: ReadonlyArray<PullRequestCheck> }
  | { readonly kind: "checks-passed"; readonly count: number; readonly required: boolean }
  | { readonly kind: "remarks"; readonly remarks: ReadonlyArray<PullRequestComment> }
  | { readonly kind: "conflicting" };

export interface PullRequestWatchReport {
  /** What the agent has not been told yet. Empty means no wake. */
  readonly changes: ReadonlyArray<PullRequestWatchChange>;
  /** The watch to record, whether or not anything is reported. */
  readonly next: PullRequestWatch;
  /** This report spends the last wake before the limit, so watching stops after it. */
  readonly exhausted: boolean;
}

// "action-required" is a finished check that needs someone, so the agent hears about it.
const isFailedCheck = (check: PullRequestCheck) =>
  check.status === "failure" || check.status === "cancelled" || check.status === "action-required";

/**
 * Compares a watched pull request with what its agent was last told. Each check is reported as
 * soon as it fails, so a check that never finishes (an advisory review bot) cannot hold the
 * news back. "Passed" is reported once the checks the base branch requires all passed, or all
 * checks where the host marks none required. Remarks count when someone other than the agent's
 * own account wrote them, so its own replies never wake it. `remarks` is null when the
 * conversation could not be read; remarks then wait for a later pass.
 */
export function evaluatePullRequestWatch(
  watch: PullRequestWatch,
  detail: Pick<PullRequestSnapshot, "headSha" | "checks" | "mergeability" | "viewer" | "author">,
  remarks: ReadonlyArray<PullRequestComment> | null,
): PullRequestWatchReport {
  const changes: Array<PullRequestWatchChange> = [];
  const headSha = detail.headSha ?? null;
  const headMoved = headSha !== watch.headSha;

  // An empty list keeps the last state: a host can answer with one when its check read fails.
  let failedChecks = headMoved ? [] : watch.failedChecks;
  let passed = headMoved ? false : watch.passed;
  let passedChecks = headMoved ? [] : watch.passedChecks;
  if (detail.checks.length > 0) {
    const failed = detail.checks.filter(isFailedCheck);
    const newlyFailed = failed.filter((check) => !failedChecks.includes(check.name));
    if (newlyFailed.length > 0) changes.push({ kind: "checks-failed", failed: newlyFailed });
    // A check that runs again leaves the list, so a rerun that fails again is reported.
    failedChecks = failed.map((check) => check.name);

    const required = detail.checks.filter((check) => check.required === true);
    const gate = required.length > 0 ? required : detail.checks;
    const passedNow = gate.every((check) => check.status !== "pending" && !isFailedCheck(check));
    const gateNames = gate.map((check) => check.name);
    // A watch saved before passedChecks existed takes the current names, so it does not wake.
    const told = passed && passedChecks.length === 0 ? gateNames : passedChecks;
    // A required job created and finished between two passes is never seen pending. Without
    // required checks, any check counts, and advisory bots keep adding passed ones: no wake.
    const gateGrew = required.length > 0 && gateNames.some((name) => !told.includes(name));
    if (passedNow && (!passed || gateGrew)) {
      changes.push({ kind: "checks-passed", count: gate.length, required: required.length > 0 });
    }
    passed = passedNow;
    passedChecks = passedNow ? gateNames : [];
  }

  const own = (detail.viewer ?? detail.author?.login)?.toLowerCase();
  const through = Date.parse(watch.remarksThrough);
  // An edit counts as new activity, so bots that rewrite one summary comment still wake the agent.
  const activeAt = (remark: PullRequestComment) => remark.editedAt ?? remark.createdAt;
  // GitHub times are per second, so remarks at the boundary time are told apart by ID.
  const fresh = (remarks ?? []).filter((remark) => {
    const at = Date.parse(activeAt(remark));
    return (
      (at > through || (at === through && !watch.remarkIds.includes(remark.id))) &&
      remark.author?.login.toLowerCase() !== own
    );
  });
  if (fresh.length > 0) changes.push({ kind: "remarks", remarks: fresh });
  const latest = Math.max(through, ...fresh.map((remark) => Date.parse(activeAt(remark))));
  const atLatest = fresh.filter((remark) => Date.parse(activeAt(remark)) === latest);
  const remarksThrough = latest === through ? watch.remarksThrough : activeAt(atLatest[0]!);
  const remarkIds = [
    ...(latest === through ? watch.remarkIds : []),
    ...atLatest.map((remark) => remark.id),
  ];

  if (detail.mergeability === "conflicting" && !watch.conflicting) {
    changes.push({ kind: "conflicting" });
  }
  // "unknown" is GitHub still computing after a push; only a clean answer clears a conflict.
  const conflicting =
    detail.mergeability === "unknown" ? watch.conflicting : detail.mergeability === "conflicting";

  const commentsOnly = changes.length > 0 && changes.every((change) => change.kind === "remarks");
  const progress = headMoved || (changes.length > 0 && !commentsOnly);
  const wakes = (progress ? 0 : watch.wakes) + (commentsOnly ? 1 : 0);
  return {
    changes,
    next: {
      startedAt: watch.startedAt,
      headSha,
      failedChecks,
      passed,
      passedChecks,
      remarksThrough,
      remarkIds,
      conflicting,
      wakes,
    },
    exhausted: commentsOnly && wakes >= PULL_REQUEST_WATCH_WAKE_LIMIT,
  };
}
