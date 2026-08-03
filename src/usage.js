'use strict';

/**
 * 唯一一份文案：`--help` 与 access 端的 HTTP 说明页共用，避免两处飘掉。
 *
 * 注意别再像早期版本那样去读自身源码的注释块 —— 打包成单文件后那招必然错乱。
 */

const { NAME, VERSION } = require('./buildinfo');

const OVERVIEW = `${NAME} v${VERSION} —— 以 WebSocket 作为信道的 TCP 端口转发

两种模式，同一个脚本：

  ${NAME} access   在你能直接访问的机器上跑（公网 VPS / 本机）。
                 起 WS + HTTP 服务，并监听本地 TCP 端口，把流量交给对面。
  ${NAME} expose   在真正能摸到目标服务的机器上跑（通常在内网）。
                 主动接入 access 端，代它连接目标服务并搬运数据。

  客户端 ──TCP──> access 的监听端口 ──WS 隧道──> expose 端 ──TCP──> 目标服务

连接方向永远是 expose 主动连 access，所以 expose 所在的网络只要能出网就行，
不需要开任何入站端口 —— 这也是它能穿内网 / NAT 的原因。`;

const ACCESS_HELP = `${OVERVIEW}

用法：
  ${NAME} access --map <本地端口:目标host:目标端口> [选项]

选项：
  --port <n>          WS 与 HTTP 共用的服务端口（默认 8080）
  --host <addr>       服务监听地址（默认 ::，即双栈；只收 IPv4 就写 0.0.0.0）
  --path <path>       WS 升级路径（默认 /tunnel）
  --map <p:host:port> 端口映射，可重复。本地监听端口 : expose 端要连的目标
                      目标是 IPv6 字面量时要加方括号，例如 '5000:[::1]:22'
  --listen-host <a>   TCP 端口监听地址（默认 127.0.0.1，要对外放开就写 0.0.0.0 或 ::）
  --token <secret>    共享口令，也可用环境变量 TUNNEL_TOKEN
  --public-http       即使设了口令，也让 HTTP 说明页与下载路由免鉴权
  --compress          开启 permessage-deflate 压缩
  --verbose           打印调试日志

HTTP 路由（与 WS 同一个端口）：
  GET /                本页说明，命令里会自动填好本机地址
  GET /download        下载这个脚本本身，拿去 expose 端直接跑
  GET /download.sha256 上面那个文件的校验和
  GET /healthz         探活用，返回 expose 端是否在线与当前流数量

例子：
  ${NAME} access --port 8080 --map 5000:127.0.0.1:22 --token 你的口令
  ${NAME} access --port 8080 --map 2222:10.0.0.9:22 --map 3307:10.0.0.9:3306 --listen-host 0.0.0.0
  ${NAME} access --port 8080 --map '5000:[::1]:22'

注意：参数里含 IPv6 方括号时，zsh 会把 [...] 当成通配符去匹配文件，匹配不到就报
zsh: no matches found 且命令不会执行。给该参数加单引号即可（bash 无此问题）。`;

const EXPOSE_HELP = `${OVERVIEW}

用法：
  ${NAME} expose --url <ws://access端:端口/tunnel> [选项]

选项：
  --url <ws url>          access 端的 WS 地址（必填，支持 ws:// 与 wss://）
  --token <secret>        共享口令，也可用环境变量 TUNNEL_TOKEN
  --connect-timeout <ms>  连接目标服务的超时（默认 10000）
  --retry-min <ms>        断线重连的初始间隔（默认 1000）
  --retry-max <ms>        断线重连的最大间隔（默认 30000）
  --insecure              wss 且证书自签时跳过校验
  --compress              开启 permessage-deflate 压缩
  --verbose               打印调试日志

转发到哪里由 access 端的 --map 决定，本端不需要配置目标。

例子：
  ${NAME} expose --url ws://1.2.3.4:8080/tunnel --token 你的口令
  ${NAME} expose --url 'ws://[240e::1]:8080/tunnel' --token 你的口令

注意：--url 是 IPv6 地址时（如 ws://[240e::1]:8080/tunnel），zsh 会把 [...] 当成
通配符，请给整个 URL 加单引号（bash 无此问题）。`;

const TOP_HELP = `${OVERVIEW}

用法：
  ${NAME} access [选项]     详细参数见 ${NAME} access --help
  ${NAME} expose [选项]     详细参数见 ${NAME} expose --help
  ${NAME} --help
  ${NAME} --version

最短路径（先起 access 端，再照它 HTTP 首页给的命令引导 expose 端）：
  ${NAME} access --port 8080 --map 5000:127.0.0.1:22 --token 你的口令
  curl -fsSL 'http://1.2.3.4:8080/?token=你的口令'`;

function modeHelp(mode) {
  if (mode === 'access') return ACCESS_HELP;
  if (mode === 'expose') return EXPOSE_HELP;
  return TOP_HELP;
}

/**
 * access 端 HTTP 首页的正文：在通用说明之外，把当前这台机器的真实地址、
 * 路径、映射列表都填进引导命令里，对面复制粘贴就能跑。
 *
 * 生成的 --url 一律带单引号：本机是 IPv6 地址时，wsUrl 里带方括号，
 * 不加引号的话照抄这段命令在 zsh 下必然报 no matches found。
 */
function httpUsage({ httpBase, wsUrl, hasToken, tokenInUrl, mappings }) {
  const q = tokenInUrl ? '?token=你的口令' : '';
  const tokenArg = hasToken ? ' --token 你的口令' : '';
  const mapLines = mappings.length
    ? mappings.map((m) => `  ${m.listenPort}  ==ws==>  ${m.target}`).join('\n')
    : '  （无）';

  return `${OVERVIEW}

────────────────────────────────────────────────────────────
本机正以 access 模式运行，当前的端口映射：

${mapLines}

在 expose 端（能访问上面那些目标的机器）执行：

  curl -fsSL '${httpBase}/download${q}' -o ${NAME}
  chmod +x ${NAME}
  ./${NAME} expose --url '${wsUrl}'${tokenArg}

只要装了 Node.js 18+ 就能跑，不需要 npm install。
校验完整性（可选）：

  curl -fsSL '${httpBase}/download.sha256${q}'
  shasum -a 256 ${NAME}
${hasToken ? '\n口令没有写在本页里，请向起 access 端的人索取，填到上面的 --token。\n' : ''}
其他路由：
  GET /healthz         expose 端是否在线、当前流数量
  GET /download.sha256 下载文件的 SHA-256

expose 端的完整参数：

${EXPOSE_HELP.slice(OVERVIEW.length).trimStart()}
`;
}

module.exports = { OVERVIEW, TOP_HELP, modeHelp, httpUsage };
