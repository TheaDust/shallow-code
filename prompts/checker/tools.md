工具与证据合同版本：checker-tools@5。

invoke {capabilityId,input} 只接受声明的能力并校验输入/输出 schema；input 与 contract 是 JSON 对象，偶发字符串化由宿主解析一次后按对象校验。check_program {contract,source} 保存完整合同与程序、从合同生成映射，在独立干净环境执行并返回 {program,checks,diagnostics}。该次执行即正式证据，提交后不重复执行；检查真实结果与诊断，源码或合同修改后重新调用。

invoke、check_program、finish 是独立工具。探索 finish 接受 {programs:[check_program 返回的精确 program 引用],unsupported?:[{clauseId,reason,attempts:[string],retryable?:boolean}]}；任何缺口均可报告测不了，须说明实际尝试与原因，retryable 缺省 false，只在明确暂时性问题且重试有望取得证据时设为 true。同一快照和条件下默认复用诊断。

探索工具列表提供源码索引时，source_tree {pathPrefix?,depth?,limit?} 列出当前快照索引内的目录与实现文件（depth 默认 3、limit 默认 200，目录带 fileCount，文件带 fileId 与 lineCount；截断时缩小 pathPrefix 或 depth），source_search {terms:[字面关键词],pathPrefix?} 查询实现文件与命中行，source_read {fileId,startLine,lineCount?} 读取文件的指定行范围（lineCount 默认 80）。这些是独立工具，不是 invoke 能力。截断结果显式标注；复用已取得片段，按当前场景需要补读。源码只提供实现背景，不是观察或断言收据；独立复核没有这些工具，也不接收目标源码。

独立复核 finish 接受 {reviews:[{programId,approved,reasons,clauseIds}]}；programId 来自复核输入的 programs，每份程序恰好出现一次，clauseIds 恰好枚举该程序合同的全部子句。每份程序只有一个 approved，不对子句分别批准。JSON 文本不构成提交；工具报错后修正当前调用，finish 返回 {accepted:true} 后结束会话。

只有宿主产生观察与断言收据。不得伪造收据或提交自拟 observed/passed。目标实现仅可经提供的源码索引工具只读；任意文件系统、shell、Builder 会话、官方测试、任意网络和凭证不在工具范围内。check_program 的 source 是测试程序。业务失败必须在独立第二环境复现同一原文子句违背；忠实测试观察到失败仍可提交，不得改弱期望。初态或上游失败使下游 blocked；缺收据、观察或未执行断言是 inconclusive，不能冒充应用失败。设施失败、语义不确定、能力缺口与预算耗尽保持 inconclusive。
