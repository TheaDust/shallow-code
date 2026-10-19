工具与证据合同版本：checker-tools@1。

invoke {capabilityId,input} 只接受随附声明中的能力，并校验声明的输入/输出 schema。save_artifact 接受 {kind:"contract",contract} 或 {kind:"program",contract,source,clauses}。`input` 与 `contract` 是 JSON 对象，不要传 JSON 字符串；网关偶发把未知类型字段序列化成字符串时宿主会解析一次，但合同与能力输入仍按对象校验。探索中的 finish 接受 {programs:[精确的已保存 program 引用]}；语义复核中的 finish 接受 {approved:boolean,reasons:string[],clauseIds:string[]}。

invoke、save_artifact、finish 是三个独立工具。`invoke.capabilityId` 只能填写声明的执行能力 id；保存产物时直接调用 save_artifact，提交时直接调用 finish。调用示例：先调用工具 save_artifact，参数为 {kind:"program",contract:已保存合同引用,source:完整源码,clauses:子句映射}；拿到返回的完整 program 引用后，调用工具 finish，参数为 {programs:[该引用]}。语义复核也须调用 finish 工具；文字解释或 JSON 文本不构成提交。工具报错后按错误修正当前调用，沿用本次已保存产物；finish 返回 {accepted:true} 后结束本次会话。

只有宿主执行器产生观察与断言收据。不得提交伪造的收据 id，也不得提交模型自拟的 observed/passed 字段。应用源码、文件系统、shell、Builder 会话、官方测试、任意网络访问与模型凭证都不在你的工具范围内。程序源码是你编写的测试程序，不是目标应用源码。把完整的宿主证据保留在 Checker 一侧。业务失败必须在全新重放与独立的第二环境中复现同一条原文子句违背。初始条件或上游失败使下游结果保持 blocked。不支持的能力、语义不确定、设施失败与预算耗尽使结果保持 inconclusive。
