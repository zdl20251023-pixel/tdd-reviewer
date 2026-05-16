import * as path from "path";
import "dotenv/config";

/**
 * P2-3 改进：配置外化
 * 所有硬编码常量统一管理，支持环境变量覆盖
 */
export const config = {
  // I/O 路径
  inputPath: path.resolve(
    process.env.TDD_INPUT || path.join(__dirname, "..", "input.md")
  ),
  outputPath: path.resolve(
    process.env.TDD_OUTPUT || path.join(__dirname, "..", "output.md")
  ),
  fewShotPath: path.resolve(
    process.env.FEW_SHOT_PATH ||
    path.join(__dirname, "..", "doc", "审查-分析结果.md")
  ),

  // 质量控制阈值
  p0Limit: 5,
  chaosDisplayLimit: 3,

  // 上下文管理
  contextMaxTokens: 3000, // Phase 2 混沌注入上下文 token 预算
  renderContextMaxTokens: 4000, // Phase 3 渲染上下文 token 预算

  // P1-3 改进：模型分级策略
  models: {
    extraction: "gemini-3-flash-preview", // Phase 1 实体提取
    analysis: "gemini-3-flash-preview", // Phase 2 System 分析
    rendering: "gemini-3-flash-preview", // Phase 3 路线 A（方案评估+优化）
    deepAnalysis: "gemini-2.5-pro", // Phase 3 路线 B（深度解析，用更强模型）
  },

  // P0-3 改进：重试配置
  retry: {
    maxAttempts: 2,
    backoffMs: 1000,
  },

  // P0-1 改进：双重提取的文档分段阈值（字符数）
  dualExtractionThreshold: 8000,
} as const;
