### 1. 方案评估
- [架构逻辑]：`nl_to_hand` 将校验中间态存内存，断线必崩。`prompt_orchestrator` 缺乏硬性路由拦截，AI 可能跳过 `nl_to_hand` 强行调用 `get_poker_coach_advice`，导致后端 C++ 引擎接收非法数据崩溃。
- [技术选型]：Vercel AI SDK SSE 与无锁 Redis 组合是灾难，高并发下 Session 状态必乱。外部 AI 引擎连接池缺乏信号量保护，延迟波动将拖死整个 Web 服务。
- [状态流转]：数据流不闭环。`LatestHandType` 到 `AIHandData` 转换路径未定义“发牌缺失”后的补全策略，会导致 `StreetManager` 状态机在推演中陷入无限循环。

### 2. 潜在风险 (P0 级，严控 5 条)

- 致命漏洞：streamText SSE 异步写与 Session 内存上下文读取的竞态冲突
  - 触发路径：高并发用户请求 -> Vercel AI SDK 开启并行 SSE 流 -> 历史消息 contextAssembly 读取尚未由前一请求完成 commit 的 Redis 脏数据 -> 注入不完整推理链路 -> 生成 SOP 违规指令
  - 降维剖析：渲染管线
  - 防御方案：在 Session 维度实现 Request Mutex，强制串行化处理并发流式更新。
- 致命漏洞：prompt_orchestrator 缺乏 ACL 导致 Redis Session 状态机非法跃迁
  - 触发路径：用户输入 -> LLM 路由逻辑输出非预期 Reasoning Text -> prompt_orchestrator 直接将无校验结果更新至 Redis Session 上下文 -> 后续步骤读取脏数据导致 SOP 崩溃
  - 降维剖析：状态机
  - 防御方案：在路由决策进入存储层前，强制通过 Zod 模式校验器实现指令级的状态准入检查。
- 致命漏洞：aiService.getPokerDecision 连接池枯竭导致的全局服务雪崩
  - 触发路径：高并发用户请求 -> prompt_orchestrator 路由至 Coach 分支 -> 密集调用 get_poker_coach_advice -> 外部 AI 引擎响应延迟增加 -> AI 服务连接池被长连接占满 -> 所有新请求在 aiService 层排队超时 -> 系统全量不可用
  - 降维剖析：内存池
  - 防御方案：为 aiService 引入基于信号量的并发控制器，并强制执行严格的 Request Timeout 熔断机制
- 致命漏洞：prompt_orchestrator 递归推理循环导致的 Token 令牌桶超载 (TPM Exhaustion)
  - 触发路径：用户输入复杂或非法牌局 -> LLM 强制执行 nl_to_hand 校验 -> 校验失败进入修复逻辑 -> LLM 在 10 步上限内反复尝试重新组装 table_Type -> 上下文携带历史 Reasoning Text 呈指数级增长 -> 单次请求消耗 Token 触及速率限制 (TPM) -> 触发全局 429 错误导致全量用户服务中断
  - 降维剖析：渲染管线
  - 防御方案：在 Orchestrator 层实施严格的 Sliding Window 上下文裁剪，并根据 Token 消耗速度动态调整 stepCount 上限
- 致命漏洞：prompt_orchestrator 缺乏防腐层导致业务编排逻辑坍缩
  - 触发路径：用户输入模糊意图 -> LLM 未按 SOP 路由 -> 绕过 nl_to_hand 强校验 -> 产生不可预测的工具调用链 -> 导致下游逻辑状态机死循环或内存崩溃
  - 降维剖析：状态机
  - 防御方案：强制 Orchestrator 使用结构化输出（如 JSON Mode），并在路由分发点引入基于 Schema 的决策验证器

### 3. 优化建议
- [防御性方案]：
    - **加锁**：针对 Redis Session 实施基于 `session_id` 的分布式锁，强制 SSE 请求串行执行，消除脏写。
    - **准入**：在 `prompt_orchestrator` 路由点加装 Zod 校验网关，非 JSON 格式或非法指令直接阻断，防止状态机跃迁。
    - **熔断**：为 `aiService` 配置 3 秒硬超时与熔断器，超时直接降级为 LLM 概率推断，释放连接池。
    - **持久化**：将 `nl_to_hand` 的 `post-parse` 修复数据写入 Redis 暂存，确保校验链路可跨实例恢复。
- [降本增效]：
    - **剪裁**：`ai_data_bridge` 转换时丢弃 `name`、`avatar` 等与策略无关的字段，压缩 Token 负载。
    - **窗口**：Orchestrator 实施滑动窗口裁剪，每轮迭代强制清除 3 步之前的 Reasoning Text，防止 Token 消耗指数爆炸。

### 4. 深度解析

- [底层原理]：`prompt_orchestrator` 本质是将大模型（LLM）作为不可靠的 CPU 指令集，通过 `stepCount` 试图构建一个确定性的业务逻辑循环。其核心风险在于：Vercel AI SDK 的 `streamText` SSE 流式输出是典型的异步高并发行为，而后端 Redis Session 是共享的全局状态。在没有分布式锁或 Request Mutex 的情况下，多个并发请求会同时读写同一个 `LatestHandType` 指针，导致 `nl_to_hand` 的四层校验机制在“脏数据”上推演。一旦校验器进入 `AutoFix` 逻辑，LLM 为了强行对齐 `结算守恒` 会进行过度推理（Over-reasoning），这不仅会导致单次请求的 Token 消耗呈指数级膨胀（TPM Exhaustion），更会因为缺乏“指令级准入检查”让错误的状态机跳转直接污染持久化层。

- [底层逻辑映射]：
    - **渲染管线（Rendering Pipeline）中的流水线停顿（Pipeline Stall）**：
      我们将“自然语言 → `nl_to_hand` 结构化 → `get_poker_coach_advice` 策略输出”映射为一条标准的渲染管线。用户输入是原始几何数据，`nl_to_hand` 是顶点着色器（负责坐标修复与格式对齐）。当前的 P0 级漏洞在于：当顶点着色器（校验修复）失败时，系统没有丢弃残次帧，而是允许 `prompt_orchestrator` 带着错误的上下文强行进入像素着色器（AI 策略求解）。这种逻辑坍缩会导致管线彻底阻塞，最终表现为前端 SSE 流输出的“策略幻觉”或全局服务雪崩（TPM 耗尽）。
    - **状态同步（State Sync）模型中的回滚机制缺失**：
      系统当前的 `hand_simulator` 充当了“权威服务器（Authoritative Server）”，而 `LatestHandType` 是同步给 LLM 的逻辑帧。由于 `Coach Mode` 下允许“非终态推演”，系统本质上在做“客户端表现预测（Client-side Prediction）”。然而，文档中缺乏“状态回滚（Rollback）”设计。当 LLM 生成的 `actions` 序列与引擎规则冲突时，系统只会盲目累加 `stepCount` 进行重试，而没有将 `LatestHandType` 强行回滚至上一个合法快照。这等同于在帧同步游戏中，客户端已经预测到了第 100 帧，但服务端校验失败后，客户端依然在错误的基础上继续模拟，最终导致逻辑指针永久性漂移。

### 5. 混沌测试：缺失降级兜底的模块

- [get_poker_coach_advice_tool] AI 接口超时 10 秒
  - 级联后果：用户发起 Coach Mode 请求 -> aiService.getPokerDecision 调用长时间阻塞 -> 超过 Orchestrator 的响应预期或触发前端超时 -> 由于 stepCountIs(10) 的步数限制，长时间阻塞可能导致任务序列中断 -> 最终用户感知为页面卡死或返回空白指导建议
  - 建议：为 AI 策略引擎设置 3-5 秒的严格超时阈值，若超时则触发降级逻辑，由 LLM 基于 nl_to_hand 校验后的牌谱提供基于概率常识的文字分析，而非阻塞等待引擎。
- [prompt_orchestrator] 并发写入同一 Session 资源冲突
  - 级联后果：用户快速发送多条指令 -> Vercel AI SDK 开启多个并发 streamText 请求 -> 多个请求竞争写入 Redis 维护的同一个 Session 上下文 -> StepCount 累加出错或路由决策被覆盖 -> 导致执行流程跳过 nl_to_hand 校验直接进入策略请求 -> 系统抛出数据结构不匹配异常
  - 建议：针对 Redis 维护的 Session 引入分布式锁或乐观锁机制，确保单个 Session 在同一时间内只有一个 Orchestrator 实例在更新状态和累加 StepCount。
- [nl_to_hand] 上下文/Session 突然丢失
  - 级联后果：四层校验机制执行到一半时内存状态丢失 -> 执行中的 post-parse 修复或模拟器推演无法获取 LatestHandType 指针 -> 校验流程直接崩溃并抛出 NullPointer 异常 -> 用户输入的自然语言描述无法转化为结构化 JSON -> 复盘/指导功能完全失效
  - 建议：将 nl_to_hand 的校验中间态（特别是 post-parse 修复后的 JSON）持久化到 Redis 缓存中，而非仅存储于内存，确保即便服务重启或 Session 漂移也能恢复校验进度。