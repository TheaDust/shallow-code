工具与证据合同版本：checker-tools@1。

一次探索可以处理同一功能组的多个需求；每份 contract/program 只覆盖一个 requirementId/scenarioId。分别保存各场景程序后一次 finish 提交。宿主逐程序独立重放与复核，结果仍按原文子句记录。

invoke {capabilityId,input} 只接受随附声明中的能力，并校验声明的输入/输出 schema。save_artifact 接受 {kind:"contract",contract} 或 {kind:"program",contract,source,clauses}。`input` 与 `contract` 是 JSON 对象，不要传 JSON 字符串；网关偶发把未知类型字段序列化成字符串时宿主会解析一次，但合同与能力输入仍按对象校验。探索中的 finish 接受 {programs:[精确的已保存 program 引用],unsupported?:[{clauseId,reason,attempts:[string],retryable?:boolean}]}；任何缺口均可报告当前测不了，须说明实际尝试和具体原因，不需要能力限制 id。retryable 缺省为 false，同一快照和执行条件下复用诊断；仅对有明确重试依据的暂时性问题设置 true，并在 reason 中解释。语义复核中的 finish 接受 {approved:boolean,reasons:string[],clauseIds:string[]}。

invoke、save_artifact、finish 是三个独立工具。`invoke.capabilityId` 只能填写声明的执行能力 id；保存产物时直接调用 save_artifact，提交时直接调用 finish。探索中的必要顺序：先调用 save_artifact，参数为 {kind:"program",contract:已保存合同引用,source:完整源码,clauses:子句映射}；拿到完整 program 引用后，必须用声明的能力重建干净 case，完整试跑该引用并检查真实断言与错误，修正程序错误；修改后须重新保存、重新试跑最终引用；每个最终程序均完成自检后，才调用 finish，参数为 {programs:[这些精确引用]}。语义正确的程序观察到业务断言失败仍可提交，不得改弱期望来换取通过；无法完成验证的子句用 unsupported 如实说明。语义复核也须调用 finish 工具；文字解释和 JSON 文本不构成提交，口头声称已试跑也不能代替真实执行。工具报错后按错误修正当前调用，沿用本次已保存产物；finish 返回 {accepted:true} 后结束本次会话。

只有宿主执行器产生观察与断言收据。不得提交伪造的收据 id，也不得提交模型自拟的 observed/passed 字段。应用源码、文件系统、shell、Builder 会话、官方测试、任意网络访问与模型凭证都不在你的工具范围内。程序源码是你编写的测试程序，不是目标应用源码。把完整的宿主证据保留在 Checker 一侧。业务失败必须在全新重放与独立的第二环境中复现同一条原文子句违背。初始条件或上游失败使下游结果保持 blocked；程序未记录必需 checkpoint 收据、缺少观察或未执行断言属于 inconclusive，不应写成应用失败。不支持的能力、语义不确定、设施失败与预算耗尽使结果保持 inconclusive。
