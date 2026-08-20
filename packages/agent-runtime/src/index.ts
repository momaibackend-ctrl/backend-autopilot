import { UnsupportedOperation } from "../../core/src/errors.js";

export interface AgentRequest<TInput = unknown> {
  operation: string;
  input: TInput;
  correlationId: string;
}
export interface AgentRuntime {
  readonly mode: "EXTERNAL" | "INTERNAL";
  invoke<TInput, TOutput>(request: AgentRequest<TInput>): Promise<TOutput>;
}
export class ExternalAgentRuntime implements AgentRuntime {
  readonly mode = "EXTERNAL" as const;
  async invoke<TInput, TOutput>(
    _request: AgentRequest<TInput>,
  ): Promise<TOutput> {
    throw new UnsupportedOperation(
      "External Agent Mode is driven through semantic MCP operations; it does not invoke an LLM",
    );
  }
}
export interface LlmProvider {
  complete<T>(request: AgentRequest): Promise<T>;
}
export class InternalAgentRuntime implements AgentRuntime {
  readonly mode = "INTERNAL" as const;
  constructor(private provider?: LlmProvider) {}
  async invoke<TInput, TOutput>(
    request: AgentRequest<TInput>,
  ): Promise<TOutput> {
    if (!this.provider)
      throw new UnsupportedOperation(
        "Internal agent provider is not configured in v0.3",
      );
    return this.provider.complete<TOutput>(request);
  }
}
