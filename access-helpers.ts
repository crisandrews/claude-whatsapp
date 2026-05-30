// Pure access-control decisions, extracted from server.ts so the security
// logic can be unit-tested without standing up the MCP server. Each function
// is a single source of truth for one rule.

/** Minimal structural view of access.json these decisions need. */
export interface AccessView {
  ownerJids: string[]
  /** Runtime on/off switch for owner-DM access commands. One of two required
   *  factors (the other is the out-of-band env var). Default false. */
  allowOwnerDmMutations?: boolean
}

// ---------------------------------------------------------------------------
// Owner-DM access commands (Phase 4) — plugin-native, never agent-mediated
// ---------------------------------------------------------------------------
// The owner can run a tiny, owner-authorized set of access mutations from a 1:1
// DM IFF two independent factors are both true:
//   (1) env var WHATSAPP_ALLOW_OWNER_DM_MUTATIONS=1 — out-of-band, the agent
//       cannot set it (mirrors WHATSAPP_OWNER_BYPASS); and
//   (2) access.json `allowOwnerDmMutations: true` — convenient terminal toggle.
// The `!access ` namespace is RESERVED: any DM text starting with it is handled
// natively (consumed, never forwarded to the agent), so an access mutation can
// never ride on LLM reasoning or a spoofable display name.

/** Both factors required. Default off. */
export function ownerDmMutationsActive(
  envEnabled: boolean,
  access: { allowOwnerDmMutations?: boolean },
): boolean {
  return envEnabled === true && access.allowOwnerDmMutations === true
}

/** True if this DM text claims the reserved `!access` namespace. Must be
 *  handled natively (consumed) regardless of authorization, so it never
 *  reaches the agent. Requires `!access` followed by whitespace or end. */
export function isOwnerDmCommandText(text: string): boolean {
  return /^!access(?:\s|$)/.test(text);
}

export type OwnerDmCommand =
  | { kind: "list" }
  | { kind: "add-group"; groupJid: string }
  | { kind: "remove-group"; groupJid: string }
  | { kind: "forbidden"; subcommand: string }
  | { kind: "invalid"; reason: string };

// Group JIDs only: digits, optionally a hyphen (legacy `<phone>-<ts>@g.us`).
// Lengths bounded so a pathological JID can't be written to access.json.
const GROUP_JID_RE = /^[0-9]{1,25}(?:-[0-9]{1,20})?@g\.us$/;

// Hard cap on a reserved command line — well above any legitimate command.
const MAX_COMMAND_LEN = 256;

// Subcommands that exist in the terminal skill but are FORBIDDEN over DM
// (they can widen access, change DM policy, or escalate ownership).
const FORBIDDEN_SUBCOMMANDS = new Set([
  "group-allow", "group-revoke", "set-scope", "policy",
  "pair", "deny", "allow", "revoke", "set-owner", "show-owner", "dm-mutations",
]);

/**
 * Parse a reserved `!access` DM line into a command. Strict: single line, no
 * leading whitespace (the caller already matched `^!access`), exact arg counts,
 * no `--flags` (e.g. `--no-mention` stays terminal-only), group JIDs validated.
 * Returns null only if the text isn't in the reserved namespace.
 */
export function parseOwnerDmCommand(text: string): OwnerDmCommand | null {
  if (!isOwnerDmCommandText(text)) return null;
  if (text.length > MAX_COMMAND_LEN) {
    return { kind: "invalid", reason: "Command too long." };
  }
  if (/[\r\n]/.test(text)) {
    return { kind: "invalid", reason: "Command must be a single line." };
  }
  const parts = text.trim().split(/\s+/);
  const sub = (parts[1] ?? "").toLowerCase();
  const args = parts.slice(2);

  if (sub === "" || sub === "list" || sub === "status") return { kind: "list" };

  if (sub === "add-group" || sub === "remove-group") {
    if (args.some((a) => a.startsWith("--"))) {
      return { kind: "forbidden", subcommand: `${sub} <flags>` };
    }
    if (args.length !== 1) {
      return { kind: "invalid", reason: `${sub} takes exactly one group JID.` };
    }
    if (!GROUP_JID_RE.test(args[0])) {
      return { kind: "invalid", reason: `Not a group JID (must end in @g.us): ${args[0]}` };
    }
    return { kind: sub === "add-group" ? "add-group" : "remove-group", groupJid: args[0] };
  }

  if (FORBIDDEN_SUBCOMMANDS.has(sub)) return { kind: "forbidden", subcommand: sub };
  return { kind: "invalid", reason: `Unknown command: ${sub}` };
}

/**
 * Who may receive — and approve — a relayed Claude Code permission prompt
 * (e.g. "Claude wants to run Bash"). OWNER ONLY: a friend on the allowlist must
 * never be able to approve a privileged tool. Group JIDs are excluded (prompts
 * are DM-only). When this is empty (no owner set), the caller should NOT relay
 * to WhatsApp at all — the terminal approval dialog stays active, so there is
 * no deadlock.
 */
export function permissionApprovers(access: AccessView): string[] {
  return access.ownerJids.filter((j) => !j.endsWith('@g.us'))
}

/**
 * May this sender approve/deny a pending permission request? Owner-only, and
 * callers MUST pass a freshly-loaded access snapshot so an owner change between
 * the prompt being sent and the reply arriving is honored (no stale trust).
 */
export function canApprovePermission(access: AccessView, senderId: string): boolean {
  return access.ownerJids.includes(senderId)
}

/**
 * Default config written when a group is auto-registered after create/join.
 * MENTION-ONLY by design: auto-OPEN would let any participant trigger the agent
 * with no terminal `/whatsapp:access` step (a governance bypass). The user can
 * widen it later from the terminal.
 */
export function newGroupAutoRegistration(): { requireMention: boolean; allowFrom: string[] } {
  return { requireMention: true, allowFrom: [] }
}
