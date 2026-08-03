# ws-port-forward

以 **WebSocket 作为信道** 的 TCP 端口转发。构建产物是**一个可直接执行的单文件脚本**（依赖一起打进去了），同一个文件靠模式参数决定自己扮演哪一端。

```
   你的 curl / ssh / 数据库客户端
            │  TCP
            ▼
    ┌────────────────┐                       ┌────────────────┐
    │  wsfwd access  │   单条 WebSocket      │  wsfwd expose  │
    │                │ ◄════ 多路复用 ════►  │                │
    │  WS + HTTP 服务 │   (ws:// 或 wss://)   │  只出网，不监听  │
    │  监听 5000 端口 │                       └───────┬────────┘
    └────────────────┘                               │ TCP
                                                     ▼
                                            127.0.0.1:22 等目标服务
```

| 模式 | 跑在哪 | 干什么 |
| --- | --- | --- |
| `access` | 你能直接访问的机器（公网 VPS / 本机） | 起 WS 服务等对端来接，起 HTTP 服务提供说明与脚本下载，同时监听本地 TCP 端口把流量交给对端 |
| `expose` | 真正能摸到目标服务的机器（通常在内网） | 主动接入 `access` 端（断线自动重连），按它的要求连接目标服务并双向搬运数据 |

连接方向永远是 **expose 主动连 access**，所以 expose 所在的网络只要能出网就行，不需要开任何入站端口 —— 这是它能穿内网 / NAT 的原因。WS 与 HTTP 共用一个端口，对外只放开一个口即可。

## 构建

只在**构建机**上需要装依赖，产物拿到哪儿都能跑（只要有 Node.js 18+）：

```bash
npm install
npm run build         # -> dist/wsfwd.js，已 chmod +x，约 165 KB
npm run build:min     # 顺手压缩（默认不压，方便对端 review 拿到的代码）
```

也可以不构建，直接跑源码调试：

```bash
node src/cli.js access --port 8080 --map 5000:127.0.0.1:9000
npm run access -- --port 8080 --map 5000:127.0.0.1:9000    # 等价
```

## 快速上手（单机演示，三个终端）

```bash
# 终端1：假装内网里的目标服务
node examples/origin-server.js 9000

# 终端2：access 端 —— 服务在 8080，本地 5000 端口转发到目标 127.0.0.1:9000
./dist/wsfwd.js access --port 8080 --map 5000:127.0.0.1:9000 --token s3cret

# 终端3：expose 端
./dist/wsfwd.js expose --url ws://127.0.0.1:8080/tunnel --token s3cret
```

然后：

```bash
curl http://127.0.0.1:5000/            # 走了一圈 WS 隧道
curl -o /dev/null "http://127.0.0.1:5000/big?mb=32"
```

## 真实场景（含把脚本发到对端）

假设 `1.2.3.4` 是公网机器，内网里有台 `10.0.0.9` 只有内网机器能访问。

先在 `1.2.3.4` 上起 access 端：

```bash
./wsfwd access \
  --port 8080 \
  --listen-host 0.0.0.0 \
  --map 2222:10.0.0.9:22 \
  --map 3307:10.0.0.9:3306 \
  --token 一串够长的随机口令
```

再在内网机器上，直接从 access 端把脚本拉下来跑 —— 不需要 git、不需要 npm install：

```bash
curl -fsSL 'http://1.2.3.4:8080/download?token=一串够长的随机口令' -o wsfwd
chmod +x wsfwd
./wsfwd expose --url ws://1.2.3.4:8080/tunnel --token 一串够长的随机口令
```

忘了命令怎么写就 `curl -fsSL 'http://1.2.3.4:8080/?token=...'`，说明页里的引导命令会自动填好这台机器的真实地址与路径。

之后 `ssh -p 2222 user@1.2.3.4` 实际连的就是 `10.0.0.9:22`。

## 参数

### `wsfwd access`

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--port <n>` | `8080` | WS 与 HTTP 共用的服务端口 |
| `--host <addr>` | `::` | 服务监听地址（双栈；只收 IPv4 就写 `0.0.0.0`） |
| `--path <path>` | `/tunnel` | WS 升级路径 |
| `--map <本地端口:目标host:目标端口>` | 必填 | 端口映射，可重复多次 |
| `--listen-host <addr>` | `127.0.0.1` | TCP 端口监听地址；要让别的机器也能用就设 `0.0.0.0` |
| `--token <secret>` | 空 | 共享口令，也可用环境变量 `TUNNEL_TOKEN` |
| `--public-http` | 关 | 即使设了口令，也让说明页与下载路由免鉴权 |
| `--compress` | 关 | 开启 permessage-deflate |
| `--verbose` | 关 | 打印调试日志 |

### `wsfwd expose`

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--url <ws url>` | 必填 | access 端的 WS 地址，支持 `ws://` / `wss://` |
| `--token <secret>` | 空 | 共享口令，也可用 `TUNNEL_TOKEN` |
| `--connect-timeout <ms>` | `10000` | 连目标服务的超时 |
| `--retry-min` / `--retry-max` | `1000` / `30000` | 重连退避区间 |
| `--insecure` | 关 | `wss` 且证书自签时跳过校验 |
| `--compress` / `--verbose` | 关 | 同上 |

转发到哪里完全由 access 端的 `--map` 决定，expose 端不配置目标。

## HTTP 路由（access 端，与 WS 同端口）

| 路由 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /` | 跟随 token | 使用说明；引导命令里会填好本机地址、路径、当前映射列表 |
| `GET /download` | 跟随 token | 下发这个脚本本身，对端存下来 `chmod +x` 就能跑 |
| `GET /download.sha256` | 跟随 token | 上面那个文件的 SHA-256，用于校验完整性 |
| `GET /healthz` | 永不鉴权 | `{"ok":true,"peerConnected":…,"streams":…}`，方便挂在网关后面探活 |

「跟随 token」= 设了 `--token` 就必须带 `?token=…` 或请求头 `x-tunnel-token`，`--public-http` 可放开。说明页里只写 `--token 你的口令` 占位符，不会回显真实口令。

`/download` 吐出去的就是当前正在运行的这个文件本身，所以两端永远版本一致。如果你跑的是源码（`node src/cli.js`），它会退回去发 `dist/wsfwd.js`；连它也没有就返回 501 并提示先 `npm run build`。

## 实现要点

- **单文件打包**：`build.js` 用 esbuild 把 `src/` 与 `ws` 打成一个 CJS 文件，注入 `__BUNDLED__` / `__VERSION__`，`src/cli.js` 的 shebang 被原样提到产物首行。`bufferutil` / `utf-8-validate` 是 `ws` 的可选原生依赖，标成 external，产物里那两句 `require` 失败会被 `ws` 自己的 try/catch 吞掉，不影响功能。
- **多路复用**：`src/lib/protocol.js` 定义 5 字节头（1 字节类型 + 4 字节 streamId）的二进制帧，一个 WS 消息即一帧。一条 TCP 连接对应一个 streamId，所以任意多条连接共享同一条 WS。
- **半关闭**：`END` 帧对应 TCP 的 FIN，socket 全部以 `allowHalfOpen` 创建。「客户端发完就关写、服务端之后才回数据」这类协议（HTTP/1.0、某些 RPC）不会被截断。
- **双向背压**：写目标 socket 返回 `false` 就发 `PAUSE` 帧让对端停止读取，`drain` 后发 `RESUME`；同时监控 `ws.bufferedAmount`，超过 1MB 暂停所有源 socket，降到 256KB 再恢复。慢客户端不会把内存吃爆。
- **鉴权**：口令走 `x-tunnel-token` 请求头（或 `?token=`），常量时间比较，WS 接入与 HTTP 路由共用同一把口令。
- **保活**：两端各 30s 一次 ping，对端不回 pong 就断开；expose 侧指数退避 + 抖动重连；access 侧同一时刻只保留一个 expose 端，新连接顶掉旧的。
- **文案单一来源**：`src/usage.js` 一份文案同时供 `--help` 与 HTTP 说明页使用（早期版本靠读自身源码注释块生成 `--help`，那招打包后必然错乱）。

## 已实测

单文件产物跑通并验证过：说明页/下载/校验和/探活四个路由、无口令与错口令下 HTTP 返回 401、`/healthz` 免鉴权、从 access 端下载脚本到空目录直接运行（无 `node_modules`）、下载文件 SHA-256 与服务端一致、基础 HTTP 请求、IPv6 目标映射（`'5001:[::1]:9000'` 方括号全链路不丢）、32MB 下行、24MB 上行 SHA256 前后一致、40 路并发全 200、HTTP/1.0 半关闭透传、WS 接入口令错误被拒 401、expose 端未接入时端口连接立即被拒、access 端重启后 expose 自动重连并恢复转发、源码模式下 `/download` 正确退回 `dist` 产物。收尾时 `streams` 归零无残留。

## 注意

- **zsh 下 IPv6 地址要加引号**：参数里含 IPv6 方括号时（如 `--url ws://[240e::1]:8080/tunnel` 或 `--map 5000:[::1]:22`），zsh 会把 `[...]` 当成通配符去匹配文件，匹配不到就报 `zsh: no matches found` 且命令不会执行。给参数整体加单引号即可：

  ```bash
  ./wsfwd expose --url 'ws://[240e::1]:8080/tunnel' --token xxxx
  ./wsfwd access --port 8080 --map '5000:[::1]:22'
  ```

  或在 `~/.zshrc` 里加 `setopt no_nomatch`，让匹配失败时原样传参（bash 默认就是这个行为，无此问题）。
- **口令是唯一的信任边界**：expose 端不再有目标白名单，access 端让它连哪儿它就连哪儿。所以 access 端一旦被拿下，对方就能拿 expose 端当跳板去打它所在的内网。请用足够长的随机口令，并且只在你信得过的机器上跑 access 端。
- 这是明文 `ws://` 的隧道，数据本身没有加密。走公网请用 `wss://`：在 access 端前面挂一个 Nginx/Caddy 做 TLS 终止并反代到它的端口，然后 expose 端用 `wss://your.domain/tunnel` 接入（说明页会读 `x-forwarded-proto`，反代配好后引导命令里给出的就是 `wss://`）。
- 下载路由把工具本身暴露在 HTTP 上，别在不设口令的情况下开在公网。
- 只转发 TCP，不支持 UDP。
- 请只在你自己拥有或已获授权的网络里使用。
