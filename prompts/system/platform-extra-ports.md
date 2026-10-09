公共运行合同要求兼容额外端口 {{EXTRA_PORTS}}，而评测环境只设置 PORT。后端必须满足：

- 在监听 PORT 的同时额外监听这些端口，所有端口服务同一个应用。
- 为每个端口各建一个独立的 `http.createServer(handler)` 实例；同一个 Server 只能 `listen()` 一次，对同一实例再次 `listen()` 会抛 `ERR_SERVER_ALREADY_LISTEN` 并让进程退出。
- 监听所有网卡（省略 host 或使用 0.0.0.0），不要只绑定 127.0.0.1。
- 仅当环境变量 ARC_EXTRA_PORTS=0 时跳过这些端口。

评测只设置 PORT，因此这些额外端口在评测时一定会被绑定；控制器交付验证会以同样的方式（只设置 PORT、不设置 ARC_EXTRA_PORTS）复验 PORT 与它们都能响应。生成期自检请以 ARC_EXTRA_PORTS=0 PORT={{PROBE_PORT}} 启动，不要占用这些端口。
