// Error types shared by the CLIs. A PreconditionError means "the user must fix something first"
// (workspace missing, not git-ignored, not initialized); CLIs exit with code 2 for it.

export class PreconditionError extends Error {
  /** One-line fix the user can act on, printed after the message. */
  fix: string | null;

  constructor(message: string, fix: string | null = null) {
    super(message);
    this.name = 'PreconditionError';
    this.fix = fix;
  }
}
