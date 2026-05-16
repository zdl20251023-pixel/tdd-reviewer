/**
 * P1-4 改进：Token 成本追踪器
 * 收集每个阶段的 token 用量，最终汇总输出
 */
export interface TokenUsageEntry {
  phase: string;
  promptTokens: number;
  completionTokens: number;
}

export class TokenTracker {
  private entries: TokenUsageEntry[] = [];

  record(phase: string, usage?: { promptTokens?: number; completionTokens?: number }) {
    this.entries.push({
      phase,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
    });
  }

  get totalPromptTokens(): number {
    return this.entries.reduce((sum, e) => sum + e.promptTokens, 0);
  }

  get totalCompletionTokens(): number {
    return this.entries.reduce((sum, e) => sum + e.completionTokens, 0);
  }

  get totalTokens(): number {
    return this.totalPromptTokens + this.totalCompletionTokens;
  }

  printSummary(): void {
    console.log("\n📊 [Token Usage Summary]");
    console.log("─".repeat(60));
    for (const e of this.entries) {
      const total = e.promptTokens + e.completionTokens;
      console.log(
        `   ${e.phase.padEnd(30)} | prompt: ${String(e.promptTokens).padStart(6)} | completion: ${String(e.completionTokens).padStart(6)} | total: ${String(total).padStart(7)}`
      );
    }
    console.log("─".repeat(60));
    console.log(
      `   ${"TOTAL".padEnd(30)} | prompt: ${String(this.totalPromptTokens).padStart(6)} | completion: ${String(this.totalCompletionTokens).padStart(6)} | total: ${String(this.totalTokens).padStart(7)}`
    );
  }
}
