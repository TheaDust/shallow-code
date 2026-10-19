本次会话尚未提交。保留当前会话已有的观察、合同与程序，按最新工具错误修正后，直接调用独立工具 finish。

参数须符合当前 finish 的 schema：探索提交 {programs:[已保存的完整程序引用]}；独立复核提交 {approved,reasons,clauseIds}，clauseIds 恰好枚举当前合同中的每个子句一次。invoke 只执行声明的能力，finish 是独立工具。文字解释和 JSON 文本不构成提交。finish 返回 {accepted:true} 后结束会话。
