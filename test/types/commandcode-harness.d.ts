/**
 * Minimal ambient declaration for @commandcode/harness — the ModApi type the
 * relay mod consumes. The real module is provided by Command Code's mod runtime;
 * this only exists so `tsc --noEmit` can check mods/relay.ts standalone.
 */
declare module '@commandcode/harness' {
  export interface HookState {
    sessionId?: string;
    session?: { id?: string };
  }

  export interface BeforeToolCallInput {
    toolName: string;
    input: Record<string, unknown>;
    state: HookState;
  }

  export interface AfterToolCallInput {
    toolName: string;
    input: Record<string, unknown>;
  }

  export interface ModApi {
    cwd: string;
    hooks(args: {
      beforeToolCall?: (input: BeforeToolCallInput) => Promise<unknown>;
      afterToolCall?: (input: AfterToolCallInput) => Promise<unknown>;
    }): void;
  }
}
