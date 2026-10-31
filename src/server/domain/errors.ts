// A refusal the person acting can understand and fix. `feedback` selects the message
// shown after a form submits; everything else stays a generic failure.
export class UserFacingError extends Error {
  constructor(readonly feedback: string, message: string) { super(message); this.name = "UserFacingError"; }
}
