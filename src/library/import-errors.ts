export type ImportErrorCode =
  | "missing-file"
  | "too-large"
  | "wrong-type"
  | "invalid-zip"
  | "missing-container"
  | "missing-package"
  | "encrypted";

export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}

export function isImportError(error: unknown): error is ImportError {
  return error instanceof ImportError;
}
