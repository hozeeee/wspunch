'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 极简日志器，verbose 时才输出 debug 级别。 */
function createLogger(tag, verbose = false) {
  const min = verbose ? LEVELS.debug : LEVELS.info;
  const emit = (level, stream) => (...args) => {
    if (LEVELS[level] < min) return;
    stream.write(`${ts()} [${tag}] ${level.toUpperCase().padEnd(5)} ${args.join(' ')}\n`);
  };
  return {
    debug: emit('debug', process.stdout),
    info: emit('info', process.stdout),
    warn: emit('warn', process.stderr),
    error: emit('error', process.stderr),
  };
}

/** 解析 "host:port"，支持 IPv6 字面量 "[::1]:8080"。 */
function parseHostPort(input) {
  const text = String(input).trim();
  const m = /^\[(.+)\]:(\d+)$/.exec(text) || /^([^:]+):(\d+)$/.exec(text);
  if (!m) throw new Error(`地址格式应为 host:port，收到 "${text}"`);
  const [, host, rawPort] = m;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口不合法："${text}"`);
  }
  return { host, port };
}

/** 拼 "host:port"，IPv6 字面量自动补方括号，免得拼出 "::1:22" 这种没法再解析的串。 */
function formatHostPort(host, port) {
  const text = String(host);
  const bare = text.includes(':') && !text.startsWith('[');
  return `${bare ? `[${text}]` : text}:${port}`;
}

/** 解析 expose 端的 --expose 参数：`web=127.0.0.1:9000`。 */
function parseService(input) {
  const text = String(input).trim();
  const idx = text.indexOf('=');
  if (idx <= 0) throw new Error(`服务声明格式应为 服务名=目标host:目标端口，收到 "${text}"`);
  const name = text.slice(0, idx).trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    throw new Error(`服务名只能用字母、数字与 _ . - （最长 64），收到 "${name}"`);
  }
  const { host, port } = parseHostPort(text.slice(idx + 1));
  return { name, host, port, target: formatHostPort(host, port) };
}

/** 解析 access 端的 --map 参数：`5000=web`，也接受 `5000:web`。 */
function parseMapping(input) {
  const text = String(input).trim();
  const m = /^(\d+)\s*[=:]\s*(.+)$/.exec(text);
  if (!m) throw new Error(`映射格式应为 本地端口=服务名，收到 "${text}"`);
  const listenPort = Number(m[1]);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error(`监听端口不合法："${text}"`);
  }
  const service = m[2].trim();
  if (service.includes(':')) {
    throw new Error(
      `--map 现在填的是 expose 端声明的服务名而不是地址（收到 "${text}"），` +
        '目标改由 expose 端的 --expose 服务名=host:port 声明',
    );
  }
  return { listenPort, service };
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 常量时间比较，避免令牌校验被时序探测。 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) return false;
  return require('node:crypto').timingSafeEqual(x, y);
}

module.exports = {
  createLogger,
  parseHostPort,
  formatHostPort,
  parseService,
  parseMapping,
  formatBytes,
  safeEqual,
};
