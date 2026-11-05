本次会话尚未提交。保留当前观察、合同与程序，按最新工具错误修正并完成提交前自检后，调用独立工具 finish。

探索提交前检查 check_program 的 outcomes、checks 与 diagnostics，并逐项核对本次 sourceClauses 已由提交程序或 unsupported 完整处理；源码或合同修改后重新调用 check_program，使用新返回的 programId 替换旧编号，无需手工 reset_case 或再次运行。忠实测试观察到业务失败仍可提交，无法验证时如实报告 unsupported。

finish 参数须符合当前 schema：探索 {programs:["p1","p2"],unsupported?}，编号来自本会话 check_program；独立复核 {reviews:[{programId,approved,reasons,clauseIds}]}，复核 programId 来自复核输入，每份程序一次，每份合同子句恰好一次。探索须在一次调用中提交完整程序列表，失败调用之间不累加；按错误位置修正编号，按缺口补齐覆盖后重新提交。文字解释与 JSON 文本不构成提交；返回 {accepted:true} 后结束。
