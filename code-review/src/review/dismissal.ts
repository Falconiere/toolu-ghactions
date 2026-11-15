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
// drive-by commenter on a public PR could silence the reviewer. The same gate decides
// whether a GitHub RESOLUTION settles (`"resolved"`): the PR's opener may resolve any
// thread without write access, and the bot resolves its own — neither is a ruling.
//
// Pure detection + one injected permission lookup; the pipeline stamps the result onto
// each PriorThread and reconcile/prompt/publish read it from there.
import { meetsPermission } from "@/github/event.js";
import { bare } from "@/github/threads.js";
import type { PriorThread, ThreadComment } from "@/github/threads.js";

/** How a thread was settled (see {@link classifyDismissals}). */
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

/** Opening/closing fence marker on a line (backticks or tildes), or undefined. */
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Drop every QUOTED region before scanning for the command, so a reply that merely
 * SHOWS the syntax while arguing the opposite — "you could reply `@toolu dismiss`,
 * but I think this is a real bug" — cannot fire the real thing. Covers all three
 * ways markdown quotes text: fenced blocks, inline code spans, and `>` blockquotes.
 *
 * An UNTERMINATED fence swallows the rest of the body: everything after it renders
 * as code, and erring toward "no command found" only ever leaves a finding standing
 * — the same direction every other gate in this module fails.
 *
 * Deliberately a LINE SCAN, not one regex over the whole body. A reply body is
 * attacker-influenceable and GitHub allows 65536 chars of it; a paired-fence regex
 * (`(`{3,})[\s\S]*?\1`) is quadratic on adversarial input — measured 1.8s on a
 * single 65KB body, times every reply on every thread, every run. This is linear.
 * Fence closing follows CommonMark: same character, at least as long as the opener.
 */
function stripQuoted(body: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null; // closed — this line is the closing fence, still not content
      }
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    if (/^\s*>/.test(line)) continue; // blockquote
    kept.push(line.replace(/`+[^`\n]*`+/g, "")); // inline spans
  }
  return kept.join("\n");
}

/**
 * Every non-bot reply carrying `<phrase> dismiss`, NEWEST first — the caller takes the
 * first whose author is authorized, so a drive-by command posted later can never
 * cancel a maintainer's earlier one. The bot's own replies are
 * skipped (it must never dismiss on its own words), as are unattributable ones (a
 * null GitHub author surfaces as `""` and is indistinguishable from the bot).
 * `dismiss` must END the word — `@toolu dismissive`, `dismiss3` and `dismiss_it` are
 * prose or some other token, not this command (hence `\w`, not just letters).
 */
export function explicitDismissReply(thread: PriorThread, triggerPhrase: string): ThreadComment[] {
  const phrase = triggerPhrase.trim();
  if (phrase === "") return [];
  const command = new RegExp(`${escapeRegExp(phrase)}\\s+dismiss(?!\\w)`, "i");
  return thread.replies
    .filter((r) => r.author !== "" && r.author !== thread.botLogin)
    .filter((r) => command.test(stripQuoted(r.body)))
    .reverse();
}

/**
 * The replies that could END the argument, NEWEST first: every attributable non-bot
 * reply posted after the bot's first counter-argument. Exhaustion needs the bot to have
 * already stated its counter-argument in this thread AND the author to have answered
 * after that: the author's first reply is not exhaustion — it is exactly the input the
 * model is asked to weigh this run, and the bot is owed one rebuttal. A second author
 * reply after that rebuttal means neither side is moving. The caller takes the first
 * authorized one, so a drive-by reply posted last cannot cancel the stalemate.
 *
 * TRAILING bot replies change nothing, so the verdict is IDEMPOTENT once the argument has
 * ended. publish.ts posts its closing note before the resolveReviewThread mutation and
 * both are best-effort: when the note lands but the resolve fails, the bot is the last
 * speaker on a thread whose argument really did end. Reading that as "still live" would
 * un-suppress the finding on the next run — with no reply posted to explain it, since
 * the bot then holds the last word — resurrecting the exact loop this module closes.
 */
export function argumentExhausted(thread: PriorThread): ThreadComment[] {
  if (thread.botLogin === "") return []; // can't tell our replies from theirs
  const firstBot = thread.replies.findIndex((r) => r.author === thread.botLogin);
  if (firstBot < 0) return [];
  return thread.replies
    .slice(firstBot + 1)
    .filter((r) => r.author !== "" && r.author !== thread.botLogin)
    .reverse();
}

/**
 * Stamp `.dismissal` on every thread that is settled. A GitHub resolution counts only
 * when an authorized human made it: GitHub lets whoever OPENED the PR resolve review
 * threads, write access or not, and the bot resolves its own threads too — neither is
 * a ruling on the finding. Permission lookups are memoised per login — a PR with thirty
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

/** Classify ONE thread: human rulings (an explicit command, then an authorized
 *  resolution) outrank a stalemate, whatever the thread's GitHub state. */
async function classifyOne(
  thread: PriorThread,
  opts: DismissalOptions,
  authorize: (login: string) => Promise<boolean>,
): Promise<PriorThread> {
  if (await anyAuthorized(explicitDismissReply(thread, opts.triggerPhrase), authorize)) {
    return { ...thread, dismissal: "explicit" };
  }
  const resolver = thread.resolvedBy;
  const byBot = bare(resolver) === bare(thread.botLogin);
  if (thread.isResolved && resolver !== "" && !byBot && (await authorize(resolver))) {
    return { ...thread, dismissal: "resolved" };
  }
  if (await anyAuthorized(argumentExhausted(thread), authorize)) {
    return { ...thread, dismissal: "exhausted" };
  }
  return thread;
}

/** True when any candidate's author passes the permission gate (checked in order). */
async function anyAuthorized(
  candidates: ThreadComment[],
  authorize: (login: string) => Promise<boolean>,
): Promise<boolean> {
  for (const c of candidates) if (await authorize(c.author)) return true;
  return false;
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
