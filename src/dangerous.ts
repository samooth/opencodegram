/** Commands that require explicit confirmation before running. */
export const DANGEROUS_COMMANDS = new Set(["delete", "remove", "reset", "drop", "clear", "wipe", "destroy"]);

export function isDangerousCommand(name: string): boolean {
  return DANGEROUS_COMMANDS.has(name.toLowerCase());
}
