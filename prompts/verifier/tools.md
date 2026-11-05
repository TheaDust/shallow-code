工具与证据合同版本：verifier-tools@8。

invoke {capabilityId,input} 只接受声明的能力，按 schema 提供 JSON 对象。check_program {contract,source} 保存完整合同与程序，在独立干净环境执行并返回 {programId,outcomes,checks,diagnostics,feedbackRef}。先检查 outcomes 的 status/reason（按合同依赖、收据顺序及实际断言得出的逐子句结论），再检查 checks（原始比较）与 diagnostics；checks 通过不代表证据链完整。源码或合同修改后重新调用。反馈为有界预览：通过项省略完整值，长值标记 truncated，省略数量由 receiptsOmitted/diagnosticsOmitted 给出。预览不能当作完整实际值或新观察。

read_feedback {feedbackRef,path?,offset?,limit?} 只读取当前会话反馈的指定字段与文本窗口。path 由字段名或数组下标组成，如 ["checks",0,"payload","actual"] 或 ["diagnostics",2,"message"]；省略时选整个反馈。diagnostics 最多展示最后 8 条，原数组下标等于展示下标加 diagnosticsOmitted。字符串按原文、其他字段按 JSON 读取，返回 {path,encoding,offset,totalCharacters,text,nextOffset?}。offset 缺省 0，limit 缺省 2000、最大 4000 字符。仅在摘要缺失排错所需信息时才用 read_feedback，不常规展开通过项、整段正文或全部轨迹。

invoke、check_program、finish 是独立工具。finish 接受 {programs:["p1","p2"],unsupported?:[{clauseId,reason,attempts:[string],retryable?:boolean}]}；programs 仅填写本会话 check_program 返回的 programId。程序与 unsupported 须完整且不重复地覆盖本次 sourceClauses。每次 finish 提交完整列表，失败调用之间不累加；按错误补齐缺口，修订程序后用新 programId 替换旧编号。文字或 JSON 文本不构成提交，finish 返回 {accepted:true} 后结束。覆盖不要求业务断言通过。

工具列表提供源码索引时，source_tree {pathPrefix?,depth?,limit?} 列出目录与实现文件（depth 默认 3、limit 默认 200，目录带 fileCount，文件带 fileId 与 lineCount），source_search {terms:[字面关键词],pathPrefix?} 查询文件与命中行，source_read {fileId,startLine,lineCount?} 读取指定行范围（lineCount 默认 80）。它们是独立工具，不是 invoke 能力；结果截断时缩小查询范围。

只有宿主产生观察与断言收据。不得伪造收据或提交自拟 observed/passed。目标实现仅可经提供的源码索引工具只读；任意文件系统、shell、Builder 会话、官方测试、任意网络和凭证不在工具范围内。check_program 的 source 是测试程序。初态或上游失败使下游 blocked；缺收据、观察、未执行断言、设施失败、语义不确定、能力缺口与执行超时是 inconclusive，不能冒充应用失败。
