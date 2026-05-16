/**
 * P1-2 改进：智能上下文截断
 * 保留首尾关键内容，中间省略，避免丢失文档后半部分的关键模块
 */
export function smartTruncate(text: string, maxTokens: number): string {
  // 中文约 1.5 字符/token
  const estimatedCharsPerToken = 1.5;
  const maxChars = Math.floor(maxTokens * estimatedCharsPerToken);

  if (text.length <= maxChars) return text;

  const headRatio = 0.6;
  const tailRatio = 0.3;
  const head = text.slice(0, Math.floor(maxChars * headRatio));
  const tail = text.slice(-Math.floor(maxChars * tailRatio));

  return `${head}\n\n... [中间内容已省略，共省略约 ${text.length - head.length - tail.length} 字符] ...\n\n${tail}`;
}

/**
 * 将文档按近似中点分为前后两段（尽量在段落边界切割）
 * 用于 P0-1 双重提取
 */
export function splitDocument(text: string): [string, string] {
  const midPoint = Math.floor(text.length / 2);

  // 在中点附近寻找最近的 ## 标题作为切割点
  const searchRange = text.slice(
    Math.max(0, midPoint - 500),
    Math.min(text.length, midPoint + 500)
  );
  const headingMatch = searchRange.match(/\n## /);

  let splitIndex: number;
  if (headingMatch && headingMatch.index !== undefined) {
    splitIndex = Math.max(0, midPoint - 500) + headingMatch.index;
  } else {
    // fallback: 在中点附近找最近的换行符
    const nlIndex = text.indexOf("\n", midPoint);
    splitIndex = nlIndex !== -1 ? nlIndex : midPoint;
  }

  return [text.slice(0, splitIndex), text.slice(splitIndex)];
}
