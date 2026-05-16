/**
 * P0-3 改进：通用重试机制，支持指数退避
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 2,
  backoffMs = 1000
): Promise<T> {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === maxRetries) {
        console.error(`❌ [${label}] 重试 ${maxRetries} 次后仍失败，放弃。`);
        throw e;
      }
      const delay = backoffMs * (i + 1);
      console.warn(
        `⚠️ [${label}] 第 ${i + 1}/${maxRetries} 次重试，等待 ${delay}ms...`,
        (e as Error).message
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}
