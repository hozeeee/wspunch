'use strict';

/**
 * 唯一一份文案：`--help` 与监听端的 HTTP 说明页共用，避免两处飘掉。
 *
 * 注意别再像早期版本那样去读自身源码的注释块 —— 打包成单文件后那招必然错乱。
 */

const { NAME, VERSION } = require('./buildinfo');

const OVERVIEW = `${NAME} v${VERSION} —— 以 WebSocket 作为信道的 TCP 端口转发

两种模式（角色），同一个脚本：

  ${NAME} expose   在能摸到目标服务的机器上跑。用 --expose 声明愿意暴露哪些服务，
                 收到对端按名字发来的请求后连过去并搬运数据。
  ${NAME} access   在你要用这些服务的机器上跑。用 --map 把本地 TCP 端口接到对端
                 声明的服务名上。

  客户端 ──TCP──> access 的监听端口 ──WS 隧道──> expose 端 ──TCP──> 目标服务

角色和「谁监听谁拨号」是两件独立的事，各自由参数决定：

  --port <n>      自己起服务等对端来接（WS 与 HTTP 说明页共用这个端口）
  --url <ws url>  主动去接对端的 WS 服务，断了自动重连

一对进程里必须一个给 --port、另一个给 --url，谁监听取决于哪台机器能被对方摸到：

  expose 给 --port    目标那台机器能被访问（有公网 IP / 同内网），最直观
  access 给 --port    目标那台机器在 NAT 后面出不了站，就让它拨出来接你

转发目标只在 expose 端声明，access 端只认服务名 —— 这份清单就是白名单。`;

const TRANSPORT_HELP = `接法（二选一）：
  --port <n>          自己监听，等对端来接（默认 8080，WS 与 HTTP 共用）
  --host <addr>       监听地址（默认 ::，即双栈；只收 IPv4 就写 0.0.0.0）
  --path <path>       WS 升级路径（默认 /tunnel）
  --public-http       即使设了口令，也让 HTTP 说明页与下载路由免鉴权
  --url <ws url>      改为主动去接对端（支持 ws:// 与 wss://）
  --retry-min <ms>    拨号断线重连的初始间隔（默认 1000）
  --retry-max <ms>    拨号断线重连的最大间隔（默认 30000）
  --insecure          wss 且证书自签时跳过校验

通用：
  --token <secret>    共享口令，也可用环境变量 TUNNEL_TOKEN。监听端校验，拨号端携带
  --compress          开启 permessage-deflate 压缩
  --verbose           打印调试日志`;

const HTTP_HELP = `HTTP 路由（只有监听端才有，与 WS 同一个端口）：
  GET /                本页说明，命令里会自动填好本机地址与当前配置
  GET /download        下载这个脚本本身，拿到对端直接跑
  GET /download.sha256 上面那个文件的校验和
  GET /healthz         探活用，返回本端角色、对端是否在线、当前流数量`;

const ZSH_NOTE = `注意：参数里含 IPv6 方括号时（如 --expose db=[::1]:3306 或 --url ws://[240e::1]:6789/tunnel），
zsh 会把 [...] 当成通配符去匹配文件，匹配不到就报 zsh: no matches found 且命令不会执行。
给该参数整体加单引号即可（bash 无此问题）。`;

const EXPOSE_HELP = `${OVERVIEW}

用法：
  ${NAME} expose --expose <服务名=目标host:目标端口> [--port <n> | --url <ws url>] [选项]

expose 专属：
  --expose <名字=host:port>  声明一个可暴露的服务，可重复。名字只能用字母数字与 _ . -
                             目标是 IPv6 字面量时要加方括号，例如 'db=[::1]:3306'
  --connect-timeout <ms>     连接目标服务的超时（默认 10000）

${TRANSPORT_HELP}

${HTTP_HELP}

例子：
  # 目标机器能被访问：让 expose 端监听，access 端拨进来
  ${NAME} expose --port 6789 --expose web=127.0.0.1:9000 --token 你的口令

  # 目标机器在 NAT 后面：让 access 端监听，expose 端拨出去
  ${NAME} expose --url ws://1.2.3.4:8080/tunnel --expose ssh=127.0.0.1:22 --token 你的口令

  # 一次声明多个服务
  ${NAME} expose --port 6789 --expose ssh=10.0.0.9:22 --expose db=10.0.0.9:3306 --token 你的口令

${ZSH_NOTE}`;

const ACCESS_HELP = `${OVERVIEW}

用法：
  ${NAME} access --map <本地端口=服务名> [--port <n> | --url <ws url>] [选项]

access 专属：
  --map <本地端口=服务名>  把一个本地 TCP 端口接到对端声明的服务上，可重复
                          服务名来自 expose 端的 --expose，本端不写目标地址
  --listen-host <addr>    这些 TCP 端口的监听地址（默认 127.0.0.1，要对外放开就写 0.0.0.0 或 ::）

${TRANSPORT_HELP}

${HTTP_HELP}

例子：
  # 对端（expose）在监听，本端拨过去
  ${NAME} access --url ws://1.2.3.4:6789/tunnel --map 5000=web --token 你的口令

  # 本端监听，等 NAT 后面的 expose 端拨进来
  ${NAME} access --port 8080 --map 2222=ssh --map 3307=db --listen-host 0.0.0.0 --token 你的口令

${ZSH_NOTE}`;

const TOP_HELP = `${OVERVIEW}

用法：
  ${NAME} expose [选项]     详细参数见 ${NAME} expose --help
  ${NAME} access [选项]     详细参数见 ${NAME} access --help
  ${NAME} --help
  ${NAME} --version

最短路径（在目标机器上起 expose 端，再照它 HTTP 首页给的命令引导 access 端）：
  ${NAME} expose --port 6789 --expose web=127.0.0.1:9000 --token 你的口令
  curl -fsSL 'http://1.2.3.4:6789/?token=你的口令'`;

function modeHelp(mode) {
  if (mode === 'access') return ACCESS_HELP;
  if (mode === 'expose') return EXPOSE_HELP;
  return TOP_HELP;
}

/**
 * 监听端 HTTP 首页的正文：在通用说明之外，把这台机器的真实地址、路径与当前配置
 * 都填进给对端的引导命令里，对面复制粘贴就能跑。
 *
 * 生成的 --url 一律带单引号：本机是 IPv6 地址时 wsUrl 里带方括号，
 * 不加引号的话照抄这段命令在 zsh 下必然报 no matches found。
 */
function httpUsage({ role, httpBase, wsUrl, hasToken, tokenInUrl, opts }) {
  const q = tokenInUrl ? '?token=你的口令' : '';
  const tokenArg = hasToken ? ' --token 你的口令' : '';

  // 本端是 expose 就把服务清单摊开，对端要写的是 --map；反之亦然
  const exposing = role === 'expose';
  const rows = exposing
    ? opts.services.map((s) => `  服务 ${s.name}  ==>  ${s.target}`)
    : opts.mappings.map((m) => `  本地端口 ${m.listenPort}  <==  服务 ${m.service}`);
  const peerMode = exposing ? 'access' : 'expose';
  const peerArgs = exposing
    ? opts.services.map((s, i) => `--map ${5000 + i}=${s.name}`).join(' ') || '--map 5000=服务名'
    : opts.mappings.map((m) => `--expose ${m.service}=目标host:目标端口`).join(' ');

  const intro = exposing
    ? `本机正以 expose 模式运行并监听在 ${wsUrl}，声明了这些服务：`
    : `本机正以 access 模式运行并监听在 ${wsUrl}，等对端把这些服务接过来：`;

  return `${OVERVIEW}

────────────────────────────────────────────────────────────
${intro}

${rows.join('\n') || '  （无）'}

在对端机器上执行：

  curl -fsSL '${httpBase}/download${q}' -o ${NAME}
  chmod +x ${NAME}
  ./${NAME} ${peerMode} --url '${wsUrl}' ${peerArgs}${tokenArg}

只要装了 Node.js 18+ 就能跑，不需要 npm install。
校验完整性（可选）：

  curl -fsSL '${httpBase}/download.sha256${q}'
  shasum -a 256 ${NAME}
${hasToken ? '\n口令没有写在本页里，请向起这一端的人索取，填到上面的 --token。\n' : ''}
其他路由：
  GET /healthz         本端角色、对端是否在线、当前流数量
  GET /download.sha256 下载文件的 SHA-256

对端（${peerMode} 模式）的完整参数：

${modeHelp(peerMode).slice(OVERVIEW.length).trimStart()}
`;
}

module.exports = { OVERVIEW, TOP_HELP, modeHelp, httpUsage };
