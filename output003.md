### 1. 方案评估
- [架构逻辑]：LLM_Orchestrator_Router 步进状态纯内存存储，崩溃即丢。ai_bridge.ts 中的 convertGameHandToAiRequest 强行绕过核心模块 table_Type，导致底层业务逻辑校验出现断层。
- [技术选型]：aiService.getPokerDecision 属于同步阻塞调用，C++ 算法引擎无隔离队列，并发必死。SSE 原始流直接透传未校验 JSON 给前端，渲染层缺乏防腐逻辑。
- [状态流转]：nl_to_hand 到 get_poker_coach_advice 的路径非原子化，存在中间态被篡改风险。Hand_Simulator_Engine 对非终态牌局跳过结算校验时，未定义严格的‘合法中间态’收敛边界。

### 2. 潜在风险 (P0 级，严控 5 条)

- 致命漏洞：aiService.getPokerDecision 对共享 C++ 算法引擎的非原子性调用导致决策回流污染
  - 触发路径：并发用户操作触发多个 get_poker_coach_advice 实例 -> 因 IsolationMechanism 为空导致共享 C++ 引擎上下文被覆盖 -> getAiReqData(table) 生成的 AIHandData 在引擎内部发生竞态 -> 最终返回与当前 LatestHandType 状态不一致的非法决策数据
  - 降维剖析：状态同步
  - 防御方案：在调用 aiService 之前引入针对 SessionID 的分布式锁或严格的请求队列处理机制
- 致命漏洞：SSE_Stream_Feedback_Manager 绕过 ACL 直接污染前端预渲染状态
  - 触发路径：LLM 开始生成 tool-call 原始 JSON (game_hand) -> SSE 通过 tool-call part 实时下发未校验数据 -> 前端触发“预渲染牌桌占位状态” -> 未经 nl_to_hand 校验的幻觉或格式错误数据直接写入 DOM/Store -> 视图崩溃或显示非法的游戏状态
  - 降维剖析：渲染管线
  - 防御方案：严禁在 SSE 流中透传 LLM 原始 JSON 片段，前端占位逻辑必须隔离在 shadow state 中，仅允许接收 nl_to_hand 处理后的确认帧。
- 致命漏洞：aiService.getPokerDecision 导致 C++ 算法引擎同步阻塞导致的全局雪崩
  - 触发路径：HTTP API -> LLM_Orchestrator_Router -> get_poker_coach_advice -> aiService.getPokerDecision 外部接口。由于该接口共享后端 C++ 德州 AI 算法引擎资源且缺乏隔离机制，当并发请求激增时，算法引擎计算饱和导致 RPC 响应时间线性增长，最终耗尽所有工作线程。
  - 降维剖析：状态同步
  - 防御方案：引入请求队列与背压机制，对 aiService.getPokerDecision 实施基于 QPS 的硬性限流与熔断降级。
- 致命漏洞：stepCountIs(10) 递归循环深度引发的 Token 级联超限与上下文爆炸
  - 触发路径：LLM_Orchestrator_Router 在 Coach Mode 下强制执行多步 SOP，由 service.ts 限制 10 步。在复杂牌局下，LLM 频繁触发 nl_to_hand 与 get_poker_coach_advice 的 ReAct 循环，每步累加的上下文导致 Token 消耗呈几何倍数增长，迅速触发 LLM Provider 的 Rate Limit 或 context_length_exceeded。
  - 降维剖析：渲染管线
  - 防御方案：实施动态 Token 裁剪策略，并为每步 ReAct 循环设置严格的 Incremental Token Budget。
- 致命漏洞：Review_Mode_Flow 的语言总结输出缺乏 Schema 校验包裹
  - 触发路径：用户触发复盘场景->解析牌谱正常->LLM生成总结文字->输出中包含未转义的特殊字符或非预期格式->导致前端状态机或渲染组件解析崩溃。
  - 降维剖析：状态同步
  - 防御方案：对 LLM 总结输出引入 Output Guardrails，通过 JSON Schema 强制规范化响应结构并实施后验清洗。

### 3. 优化建议
- [防御性方案]：
    - 对 aiService.getPokerDecision 增加基于 SessionID 的分布式锁与请求优先级队列。
    - 实现前端 Shadow State 隔离区，仅在 nl_to_hand 返回‘合法’确认帧后允许更新真实 DOM。
    - 在 LLM_Orchestrator_Router 中引入基于 Redis 的 SOP 状态机持久化机制。
    - 为 Review_Mode_Flow 增加基于 JSON Schema 的输出防御性清洗逻辑。
- [降本增效]：
    - 实施动态 Token 裁剪策略，针对 ReAct 循环设置严格的 Incremental Token Budget。
    - 在 nl_to_hand 之前增加 Embeddings 相似度检索缓存，复用已解析的合法牌谱。

### 4. 深度解析

- [底层原理]：核心风险在于 `convertGameHandToAiRequest` 函数。此函数被迫从一个扁平、无状态的 `LatestHandType` 结构，逆向工程出一个本应由 `hand_simulator` 引擎在内存中动态维护的、包含大量运行时字段（如 `curBet`, `currentPlayerIndex`）的复杂状态快照。这本质上是在一个无状态的转换层里，重复实现了 `hand_simulator` 的部分状态推演逻辑。这种逻辑分叉导致 `get_poker_coach_advice` 的输入数据与 `nl_to_hand` 校验时所处的模拟器内部状态 (`table_Type`) 存在潜在不一致性，并发调用 `aiService.getPokerDecision` 时，这种微小状态偏差会被放大，是竞态条件和决策污染的根源。

- [底层逻辑映射]：
    1.  **状态同步 (State Synchronization) 映射**：整个系统应被视为一个权威服务器模型。`hand_simulator` 是唯一的**权威服务器 (Authoritative Server)**，负责维护真实游戏状态。用户的自然语言是**客户端输入 (Client Command)**。大模型生成 `game_hand` JSON 的过程是**客户端表现预测 (Client-side Prediction)**，它乐观地生成一个期望的状态。`nl_to_hand` 工具是**服务器状态回滚与校验 (Server-side Reconciliation)**，它接收预测的状态，在权威服务器上重放（`StreetManager.replay()`），并拒绝非法操作。当前架构的 P0 漏洞——前端通过 SSE 流中的 `tool-call` part 进行“预渲染牌桌占位状态”，就是典型的缺少**状态回滚 (Rollback)** 机制的预测。一旦 `nl_to_hand` 校验失败，前端无法回滚到上一个合法状态，导致视图永久性污染。
    2.  **渲染管线 (Rendering Pipeline) 映射**：大模型的多工具调用链（`mainSystemPrompt` → `nl_to_hand` → `get_poker_coach_advice`）可类比为一个渲染管线。LLM 生成 `_reasoning` 文本和原始 `game_hand` JSON 是**顶点着色器 (Vertex Shader)** 阶段，处理原始输入。`nl_to_hand` 的四层校验是**几何着色器与光栅化 (Geometry Shader & Rasterization)** 阶段，它将无结构的顶点（原始 JSON）塑形、裁剪并转换为结构化、合法的图元（validated `LatestHandType`）。`get_poker_coach_advice` 调用 C++ 引擎是**计算着色器 (Compute Shader)**，执行复杂计算。最终的自然语言总结是**像素着色器 (Pixel Shader)**，输出最终颜色。P0 漏洞“SSE_Stream_Feedback_Manager 绕过 ACL 直接污染前端预渲染状态”，等同于直接将顶点着色器的输出送去显示，跳过了所有塑形和剔除阶段，必然导致渲染（前端状态）的严重错乱与崩溃。必须只允许光栅化阶段（`nl_to_hand`）的产物进入下一流程。

### 5. 混沌测试：缺失降级兜底的模块

- [nl_to_hand] AI 接口超时 10 秒
  - 级联后果：用户提交描述 -> LLM 等待 nl_to_hand 返回 -> 超过 Vercel AI SDK 或 HTTP 默认超时阈值 -> SSE 链接中断 -> 前端显示请求失败，用户无法获得牌谱解析结果，且后续的打牌指导（Coach Mode）流程被完全阻断。
  - 建议：在 nl_to_hand 内部实现针对模拟器推演的超时控制，并在工具层面增加快速失败机制；若超时，返回特定的错误码告知用户‘解析过于复杂，请简化描述’，而非让整个请求挂起。
- [get_poker_coach_advice] 并发写入同一资源冲突
  - 级联后果：多名用户或同一用户快速重复触发 Coach 请求 -> 共享的 C++ AI 算法引擎连接池压力激增 -> 转换桥接函数 convertGameHandToAiRequest 在并发环境下若无唯一请求 ID 隔离，可能导致 AIHandData 与 Session 匹配混乱 -> 用户收到了针对他人手牌的打牌建议。
  - 建议：在 Poker_Coach_Advice_Tool 执行层引入分布式锁或严格的 Snowflake ID 校验，确保每个异步请求在调用 C++ 引擎时具有严格的租户/会话隔离。
- [LLM_Orchestrator_Router] 上下文/Session 突然丢失
  - 级联后果：路由判断为 Coach Mode -> 正在执行 nl_to_hand 校验 -> Session 丢失导致 state 还原 -> 系统遗忘了‘强制验谱’的 SOP 执行进度 -> 即使 nl_to_hand 最终返回成功，路由也无法衔接至 get_poker_coach_advice，导致流程中断或循环。
  - 建议：将 StepCount 和关键状态从纯内存存储迁移至持久化缓存（如 Redis），确保 Session 闪断后能通过会话恢复机制定位到当前 SOP 执行步数。