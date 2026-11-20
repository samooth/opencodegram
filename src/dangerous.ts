/** Commands that require explicit confirmation before running. */
export const DANGEROUS_COMMANDS = new Set(["delete", "remove", "reset", "drop", "clear", "wipe", "destroy"]);

/**
 * Chat-scoped commands that change state for EVERYONE in the chat (unlink all
 * sessions, delete sessions, change shared settings, manage permissions, ops
 * and custom buttons). Only the global admin or a thread admin may run them;
 * operators may not, even though they can prompt and approve tools.
 */
export const CHAT_ADMIN_COMMANDS = new Set([
  "unlink", "deletesessions", "delete", "settings", "ops", "permissions", "buttons",
]);

export function isDangerousCommand(name: string): boolean {
  return DANGEROUS_COMMANDS.has(name.toLowerCase());
}

export function isChatAdminCommand(name: string): boolean {
  return CHAT_ADMIN_COMMANDS.has(name.toLowerCase());
}
