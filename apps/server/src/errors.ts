import type { ErrorCode } from "@draw-guess/protocol";

export class GameError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}
