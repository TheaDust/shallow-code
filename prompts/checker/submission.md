本次会话尚未提交。保留当前会话已有的观察、合同与程序，按最新工具错误修正并完成本次角色的提交前检查后，调用独立工具 finish。

探索提交前检查 check_program 返回的 checks 与 diagnostics。源码或合同修改后重新调用 check_program，提交其返回的最终 program；无需手工 reset_case 或再次运行。忠实测试观察到业务失败仍可提交，无法验证时如实报告 unsupported。

参数须符合当前 finish 的 schema：探索提交 {programs:[check_program 返回的完整程序引用],unsupported?}；独立复核提交 {reviews:[{programId,approved,reasons,clauseIds}]}，每份程序一次，每份合同的子句恰好枚举一次。finish 是独立工具，文字解释与 JSON 文本不构成提交。finish 返回 {accepted:true} 后结束会话。
