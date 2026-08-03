# ws-port-forward

以 **WebSocket 作为信道** 的 TCP 端口转发。构建产物是**一个可直接执行的单文件脚本**（依赖一起打进去了），同一个文件靠模式参数决定自己扮演哪一端。

```
   你的 curl / ssh / 数据库客户端
            │  TCP
            ▼
    ┌──────────────────┐                     ┌──────────────────┐
    │  wspunch access  │   单条 WebSocket     │  wspunch expose  │
    │                  │ ◄════ 多路复用 ════► │                  │
    │  --map 5000=web  │   (ws:// 或 wss://) │ --expose web=…    │
    └──────────────────┘                     └────────┬─────────┘
                                                      │ TCP
                                                      ▼
                                            127.0.0.1:9000 等目标服务
```

| 模式 | 跑在哪 | 干什么 |
| --- | --- | --- |
| `expose` | 真正能摸到目标服务的机器 | 用 `--expose 服务名=host:port` 声明愿意暴露哪些服务，收到对端按名字发来的请求后连过去并搬运数据 |
| `access` | 你要用这些服务的机器 | 用 `--map 本地端口=服务名` 把本地 TCP 端口接到对端声明的服务上 |

**目标地址只在 `expose` 端声明**，`access` 端只认服务名 —— 这份清单同时就是白名单，名字不在里面的请求一律被拒。

## 角色与接法是两件独立的事

哪一端起服务、哪一端拨过去，跟角色无关，各自由参数决定：

| 参数 | 含义 |
| --- | --- |
| `--port <n>` | 自己监听，等对端来接。WS 与 HTTP 说明页共用这个端口 |
| `--url <ws url>` | 主动去接对端的 WS 服务，断线指数退避 + 抖动自动重连 |

一对进程里必须**一个给 `--port`、另一个给 `--url`**，两个都给会直接报错。谁监听取决于哪台机器能被对方摸到：

```bash
# 情况 A：目标那台机器能被访问（有公网 IP / 同内网）—— 最直观，expose 起服务
机器甲(有服务)  wspunch expose --port 6789 --expose web=127.0.0.1:9000 --token xxx
机器乙(要用)    wspunch access --url ws://甲:6789/tunnel --map 5000=web --token xxx

# 情况 B：目标那台机器在 NAT 后面只能出网 —— access 起服务，expose 拨出来
机器乙(公网)    wspunch access --port 8080 --map 5000=web --token xxx
机器甲(内网)    wspunch expose --url ws://乙:8080/tunnel --expose web=127.0.0.1:9000 --token xxx
```

两种情况数据流向完全一样：`access` 的本地端口 → WS → `expose` → 目标服务。只有 TCP 握手方向不同。

## 构建

只在**构建机**上需要装依赖，产物拿到哪儿都能跑（只要有 Node.js 18+）：

```bash
npm install
npm run build         # -> dist/wspunch.js，已 chmod +x，约 172 KB
npm run build:min     # 顺手压缩（默认不压，方便对端 review 拿到的代码）
```

也可以不构建，直接跑源码调试：

```bash
node src/cli.js expose --port 6789 --expose web=127.0.0.1:9000
npm run expose -- --port 6789 --expose web=127.0.0.1:9000    # 等价
```

## 快速上手（单机演示，三个终端）

```bash
# 终端1：假装内网里的目标服务
node examples/origin-server.js 9000

# 终端2：expose 端 —— 起服务在 6789，声明一个叫 web 的服务
./dist/wspunch.js expose --port 6789 --expose web=127.0.0.1:9000 --token s3cret

# 终端3：access 端 —— 接进去，把本地 5000 接到服务 web 上
./dist/wspunch.js access --url ws://127.0.0.1:6789/tunnel --map 5000=web --token s3cret
```

然后：

```bash
curl http://127.0.0.1:5000/            # 走了一圈 WS 隧道
curl -o /dev/null "http://127.0.0.1:5000/big?mb=32"
```

## 真实场景（含把脚本发到对端）

假设 `1.2.3.4` 那台机器上跑着几个只监听回环的服务，你想从别处用它们。

先在 `1.2.3.4` 上起 expose 端，声明清单：

```bash
./wspunch expose \
  --port 6789 \
  --expose ssh=127.0.0.1:22 \
  --expose db=10.0.0.9:3306 \
  --token 一串够长的随机口令
```

再在你自己的机器上，直接从 expose 端把脚本拉下来跑 —— 不需要 git、不需要 npm install：

```bash
curl -fsSL 'http://1.2.3.4:6789/download?token=一串够长的随机口令' -o wspunch
chmod +x wspunch
./wspunch access --url ws://1.2.3.4:6789/tunnel --map 2222=ssh --map 3307=db --token 一串够长的随机口令
```

忘了命令怎么写就 `curl -fsSL 'http://1.2.3.4:6789/?token=...'`，说明页里的引导命令会自动填好这台机器的真实地址、路径与当前服务清单。

之后 `ssh -p 2222 user@127.0.0.1` 实际连的就是 `1.2.3.4` 上的 `127.0.0.1:22`。

如果 `1.2.3.4` 换成一台只能出网的内网机器，把 `--port` / `--url` 对调即可（见上面的情况 B），其余参数不变。

## 参数

### 两种模式都认的

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--port <n>` | `8080` | 监听接法：WS 与 HTTP 共用的服务端口 |
| `--host <addr>` | `::` | 监听地址（双栈；只收 IPv4 就写 `0.0.0.0`） |
| `--path <path>` | `/tunnel` | WS 升级路径 |
| `--public-http` | 关 | 即使设了口令，也让说明页与下载路由免鉴权 |
| `--url <ws url>` | —— | 拨号接法：对端的 WS 地址，支持 `ws://` / `wss://` |
| `--retry-min` / `--retry-max` | `1000` / `30000` | 拨号断线重连的退避区间 |
| `--insecure` | 关 | `wss` 且证书自签时跳过校验 |
| `--token <secret>` | 空 | 共享口令，也可用环境变量 `TUNNEL_TOKEN`。监听端校验，拨号端携带 |
| `--compress` | 关 | 开启 permessage-deflate |
| `--verbose` | 关 | 打印调试日志 |

`--host` / `--path` / `--public-http` 只在给了 `--port` 时有意义；`--retry-*` / `--insecure` 只在给了 `--url` 时有意义。混用会报错或被忽略。

### `wspunch expose` 专属

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--expose <名字=目标host:目标端口>` | 必填 | 声明一个可暴露的服务，可重复。名字只能用字母数字与 `_ . -`；目标是 IPv6 字面量要加方括号，如 `'db=[::1]:3306'` |
| `--connect-timeout <ms>` | `10000` | 连目标服务的超时 |

### `wspunch access` 专属

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--map <本地端口=服务名>` | 必填 | 把一个本地 TCP 端口接到对端声明的服务上，可重复。也接受 `5000:web` 这种写法 |
| `--listen-host <addr>` | `127.0.0.1` | 这些 TCP 端口的监听地址；要让别的机器也能用就设 `0.0.0.0` |

## HTTP 路由（只有监听端才有，与 WS 同端口）

| 路由 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /` | 跟随 token | 使用说明；引导命令里会填好本机地址、路径，以及当前的服务清单或映射列表 |
| `GET /download` | 跟随 token | 下发这个脚本本身，对端存下来 `chmod +x` 就能跑另一个模式 |
| `GET /download.sha256` | 跟随 token | 上面那个文件的 SHA-256，用于校验完整性 |
| `GET /healthz` | 永不鉴权 | `{"ok":true,"role":…,"peerConnected":…,"streams":…}`，方便挂在网关后面探活 |

「跟随 token」= 设了 `--token` 就必须带 `?token=…` 或请求头 `x-tunnel-token`，`--public-http` 可放开。说明页里只写 `--token 你的口令` 占位符，不会回显真实口令。

`/download` 吐出去的就是当前正在运行的这个文件本身，所以两端永远版本一致。如果你跑的是源码（`node src/cli.js`），它会退回去发 `dist/wspunch.js`；连它也没有就返回 501 并提示先 `npm run build`。

## 实现要点

- **单文件打包**：`build.js` 用 esbuild 把 `src/` 与 `ws` 打成一个 CJS 文件，注入 `__BUNDLED__` / `__VERSION__`，`src/cli.js` 的 shebang 被原样提到产物首行。`bufferutil` / `utf-8-validate` 是 `ws` 的可选原生依赖，标成 external，产物里那两句 `require` 失败会被 `ws` 自己的 try/catch 吞掉，不影响功能。
- **角色与接法解耦**：`src/lib/link.js` 只管「那条 WS 怎么建起来」（监听还是拨号、单 peer 管理、心跳、重连），两个模式共用；`src/modes/*.js` 只管角色行为。所以四种组合（expose/access × 监听/拨号）都是同一套代码路径。
- **服务清单**：WS 一建起来，`expose` 端就发一个 `SERVICES` 帧把 `名字 -> 目标` 清单下发给对端；`access` 端据此校验自己的 `--map`，映射了不存在的名字会在启动阶段就报错，端口上的连接直接被拒，不用白跑一趟 WS。
- **多路复用**：`src/lib/protocol.js` 定义 5 字节头（1 字节类型 + 4 字节 streamId）的二进制帧，一个 WS 消息即一帧。一条 TCP 连接对应一个 streamId，所以任意多条连接共享同一条 WS。`OPEN` 帧的 payload 是服务名而不是地址。
- **半关闭**：`END` 帧对应 TCP 的 FIN，socket 全部以 `allowHalfOpen` 创建。「客户端发完就关写、服务端之后才回数据」这类协议（HTTP/1.0、某些 RPC）不会被截断。
- **双向背压**：写目标 socket 返回 `false` 就发 `PAUSE` 帧让对端停止读取，`drain` 后发 `RESUME`；同时监控 `ws.bufferedAmount`，超过 1MB 暂停所有源 socket，降到 256KB 再恢复。慢客户端不会把内存吃爆。
- **鉴权**：口令走 `x-tunnel-token` 请求头（或 `?token=`），常量时间比较，WS 接入与 HTTP 路由共用同一把口令。
- **保活**：两端各 30s 一次 ping，对端不回 pong 就断开；拨号侧指数退避 + 抖动重连；监听侧同一时刻只保留一个对端，新连接顶掉旧的。
- **文案单一来源**：`src/usage.js` 一份文案同时供 `--help` 与 HTTP 说明页使用，且说明页会按本端角色自动生成给对端的那条命令（本端是 expose 就给出对端的 `--map`，反之给出 `--expose`）。

## 已实测

单文件产物在两种接法下都跑通并验证过：

- **expose 监听 / access 拨号**：基础 HTTP 请求、32MB 下行、8MB 上行 SHA-256 前后一致、20 路并发全 200、`/healthz` 显示 `role=expose` 且 `peerConnected=true`、`--map` 指向未声明的服务名时连接被立即拒绝并打出明确日志、WS 接入口令错误被拒 401、说明页无口令 401 / 带口令 200、`/download` 下载的文件与 `/download.sha256` 一致。
- **access 监听 / expose 拨号**：基础请求、IPv6 目标（`'v6=[::1]:19001'` 方括号全链路不丢）、HTTP/1.0 半关闭透传、expose 端未接入时端口连接立即被拒、access 端重启后 expose 自动退避重连并恢复转发、说明页里给对端的 `--expose` 引导命令按当前映射自动生成。
- **参数校验**：`--port` 与 `--url` 同时给、`--host` 用在拨号模式、`--map` 误填成旧的 `本地端口:host:port` 格式、`--map` 重复用同一个本地端口、`--expose` 重名，都在启动前报出可读的中文错误。

收尾时 `streams` 归零无残留。

## 注意

- **zsh 下 IPv6 地址要加引号**：参数里含 IPv6 方括号时（如 `--url ws://[240e::1]:6789/tunnel` 或 `--expose 'db=[::1]:3306'`），zsh 会把 `[...]` 当成通配符去匹配文件，匹配不到就报 `zsh: no matches found` 且命令不会执行。给参数整体加单引号即可：

  ```bash
  ./wspunch access --url 'ws://[240e::1]:6789/tunnel' --map 5000=web --token xxxx
  ./wspunch expose --port 6789 --expose 'db=[::1]:3306'
  ```

  或在 `~/.zshrc` 里加 `setopt no_nomatch`，让匹配失败时原样传参（bash 默认就是这个行为，无此问题）。
- **清单就是信任边界**：`expose` 端只会连自己 `--expose` 声明过的那几个地址，所以拿到口令的人也只能用到这些服务，点不到别的内网地址。想收紧就少声明几个；想放开就多声明几个 —— 别为了图省事声明一个指向跳板的服务。
- **口令要够长**：口令是接入这条隧道的唯一门槛，请用随机长串，并优先走 `wss://`。
- 这是明文 `ws://` 的隧道，数据本身没有加密。走公网请用 `wss://`：在监听端前面挂一个 Nginx/Caddy 做 TLS 终止并反代到它的端口，然后另一端用 `wss://your.domain/tunnel` 接入（说明页会读 `x-forwarded-proto`，反代配好后引导命令里给出的就是 `wss://`）。
- 下载路由把工具本身暴露在 HTTP 上，别在不设口令的情况下开在公网。
- 只转发 TCP，不支持 UDP。
- 请只在你自己拥有或已获授权的网络里使用。
