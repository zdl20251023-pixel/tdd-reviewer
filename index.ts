import "dotenv/config";
import { runPipeline } from "./src/pipeline";

/**
 * TDD-Reviewer v4 入口
 * 所有逻辑已拆分至 src/ 下的模块，此处仅负责启动和顶层错误处理
 */
async function main() {
  try {
    await runPipeline();
  } catch (error) {
    console.error("❌ [System Crash] 管线执行失败:", error);
    process.exit(1);
  }
}

main();
