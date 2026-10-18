---
name: web-delivery
description: Diagnose or repair Web installation, builds, startup, readiness, production serving, declared ports or runtime data paths during development or delivery checks.
---

# Web 运行与交付

从项目运行合同核对安装、构建、启动、相对 cwd、环境、就绪地址、浏览器入口和数据目录。具体框架、服务布局和路由采用项目声明；健康检查在必要依赖就绪后成功，公开入口和资源在正式运行方式下可访问。

定位失败阶段并检查实际命令、子进程退出、端口释放、构建产物与静态资源路径。开发代理或热更新服务存在时，核对交付启动本身如何提供对应页面和接口。声明的页面直达与刷新路径均应可重复访问。

停止开发应用后再重建，使用 app 工具取得当前运行地址，按实际检查结果报告。修复后从干净进程执行合同要求的检查；业务代码改变时复查受影响行为，构建或启动成功只证明对应运行阶段。
