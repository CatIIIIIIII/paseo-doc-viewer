import { errorCode } from "../shared/errors";

export function passwordPrompt(error: unknown): { incorrect: boolean } | null {
  const code = errorCode(error);
  if (code === "password_required") return { incorrect: false };
  return code === "password_incorrect" ? { incorrect: true } : null;
}
