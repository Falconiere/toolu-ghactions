// review/dismissal.ts — detect, deterministically, when the author has SETTLED one of
// the bot's inline findings WITHOUT resolving its thread on GitHub. Resolving a thread
// used to be the ONLY dismissal channel, so an author who refused or explained a finding
// in a REPLY had it re-raised on every later run: the reply reached the model as soft
// "accept-or-argue" context, the model kept its position, and the bot re-posted the same
// counter-argument round after round. Two channels close that gap:
//
//   - "explicit"  — an authorized reply carrying `<TRIGGER_PHRASE> dismiss`. A deliberate
//                   human ruling on THAT finding: it silences any severity, but only on an
//                   exact fp / path+line match (see reconcile.ts's matchesSettled).
//   - "exhausted" — the bot already argued the point once and the author answered again.
//                   An automatic agree-to-disagree, NOT a human ruling, so it never
//                   silences a blocker (same principle as the MAX_ROUNDS cap in gate.ts).
//
// Both are gated on the SAME repo-permission floor as the @mention re-trigger
// (MIN_TRIGGER_PERMISSION) and FAIL CLOSED — no lookup, a throwing lookup, or an
// insufficient permission all leave the thread undismissed. Without that gate any
// drive-by commenter on a public PR could silence the reviewer, which resolving a
// thread (write/triage only) never allowed.
//
// Pure detection + one injected permission lookup; the pipeline stamps the result onto
// each PriorThread and reconcile/prompt/publish read it from there.
import { meetsPermission } from "@/github/event.js";
import type { PriorThread, ThreadComment } from "@/github/threads.js";

/** How a thread was settled by the author short of resolving it on GitHub. */
export type Dismissal = NonNullable<PriorThread["dismissal"]>;

/** What {@link classifyDismissals} needs: the mention phrase and the permission gate. */
export interface DismissalOptions {
  /** Mention prefix (TRIGGER_PHRASE, default `@toolu`); the command is `<phrase> dismiss`. */
  triggerPhrase: string;
  /** Permission floor a dismissing login must clear (MIN_TRIGGER_PERMISSION). */
  minPermission: "write" | "admin";
  /**
   * Repo-permission lookup for a login, returning the GitHub permission string or
   * throwing on any API error. ABSENT disables both channels (fail closed).
   */
  lookupPermission?: ((login: string) => Promise<string>) | undefined;
}

/** Escape a user-supplied phrase for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Drop markdown blockquote lines before scanning for the command, so QUOTING a
 * dismissal (`> @toolu dismiss`) while arguing against it cannot fire the real one.
 */
function stripQuotes(body: string): string {
  return body
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

/**
 * The LAST non-bot reply carrying `<phrase> dismiss`, or null. Last wins: an author
 * may argue first and dismiss later in the same thread. The bot's own replies are
 * skipped (it must never dismiss on its own words), as are unattributable ones (a
 * null GitHub author surfaces as `""` and is indistinguishable from the bot).
 * `dismiss` must end the word — `@toolu dismissive` is prose, not a command.
 */
export function explicitDismissReply(
  thread: PriorThread,
  triggerPhrase: string,
): ThreadComment | null {
  const phrase = triggerPhrase.trim();
  if (phrase === "") return null;
  const command = new RegExp(`${escapeRegExp(phrase)}\\s+dismiss(?![a-z])`, "i");
  for (let i = thread.replies.length - 1; i >= 0; i--) {
    const reply = thread.replies[i];
    if (!reply || reply.author === "" || reply.author === thread.botLogin) continue;
    if (command.test(stripQuotes(reply.body))) return reply;
  }
  return null;
}

/**
 * The author reply that ENDS the argument, or null. Exhaustion needs the bot to have
 * already stated its counter-argument in this thread AND the author to have answered
 * after that: the author's first reply is not exhaustion — it is exactly the input the
 * model is asked to weigh this run, and the bot is owed one rebuttal. A second author
 * reply after that rebuttal means neither side is moving.
 */
export function argumentExhausted(thread: PriorThread): ThreadComment | null {
  if (thread.botLogin === "") return null; // can't tell our replies from theirs
  const last = thread.replies.at(-1);
  if (!last || last.author === "" || last.author === thread.botLogin) return null;
  const botArgued = thread.replies.slice(0, -1).some((r) => r.author === thread.botLogin);
  return botArgued ? last : null;
}

/**
 * Stamp `.dismissal` on every thread the author has settled without resolving it.
 * Already-resolved threads are returned untouched (GitHub's own resolution already
 * suppresses them). Permission lookups are memoised per login — a PR with thirty
 * threads and one author costs one API call — and every failure path yields "not
 * dismissed", so a flaky permissions API degrades to today's behaviour instead of
 * silencing findings. Never throws.
 */
export async function classifyDismissals(
  threads: PriorThread[],
  opts: DismissalOptions,
): Promise<PriorThread[]> {
  const seen = new Map<string, Promise<boolean>>();
  const authorize = (login: string): Promise<boolean> => {
    const hit = seen.get(login);
    if (hit) return hit;
    const pending = isAuthorized(login, opts);
    seen.set(login, pending);
    return pending;
  };

  const out: PriorThread[] = [];
  for (const thread of threads) {
    out.push(await classifyOne(thread, opts, authorize));
  }
  return out;
}

/** Classify ONE thread: explicit command first (a ruling outranks a stalemate). */
async function classifyOne(
  thread: PriorThread,
  opts: DismissalOptions,
  authorize: (login: string) => Promise<boolean>,
): Promise<PriorThread> {
  if (thread.isResolved) return thread;
  const explicit = explicitDismissReply(thread, opts.triggerPhrase);
  if (explicit && (await authorize(explicit.author))) {
    return { ...thread, dismissal: "explicit" };
  }
  const closing = argumentExhausted(thread);
  if (closing && (await authorize(closing.author))) {
    return { ...thread, dismissal: "exhausted" };
  }
  return thread;
}

/** FAIL-CLOSED permission check: no login, no lookup, a throw, or too little access → false. */
async function isAuthorized(login: string, opts: DismissalOptions): Promise<boolean> {
  if (login === "" || !opts.lookupPermission) return false;
  try {
    return meetsPermission(await opts.lookupPermission(login), opts.minPermission);
  } catch {
    return false;
  }
}
