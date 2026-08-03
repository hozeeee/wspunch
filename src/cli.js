#!/usr/bin/env node
'use strict';

/**
 * 命令行入口：解析 `模式 + 选项`，然后把归一化后的配置交给对应模式。
 *
 * 模式决定角色，--port / --url 决定接法（谁监听、谁拨号），两者互相独立：
 *
 *   wspunch expose --port 6789 --expose web=127.0.0.1:9000 --token xxx
 *   wspunch access --url ws://1.2.3.4:6789/tunnel --map 5000=web --token xxx
 *
 *   wspunch access --port 8080 --map 5000=web --token xxx
 *   wspunch expose --url ws://1.2.3.4:8080/tunnel --expose web=127.0.0.1:9000 --token xxx
 */

const { parseArgs } = require('node:util');

const { NAME, VERSION } = require('./buildinfo');
const { modeHelp, TOP_HELP } = require('./usage');
const { parseMapping, parseService } = require('./lib/util');

// 静态 require，别写成 require(`./modes/${mode}`) —— 那样 esbuild 打包时分析不到
const RUNNERS = {
  access: require('./modes/access').run,
  expose: require('./modes/expose').run,
};
const MODES = Object.keys(RUNNERS);

/** 两种模式都认的选项：口令、接法、开关。 */
const COMMON_OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  path: { type: 'string' },
  url: { type: 'string' },
  token: { type: 'string' },
  'retry-min': { type: 'string' },
  'retry-max': { type: 'string' },
  insecure: { type: 'boolean', default: false },
  'public-http': { type: 'boolean', default: false },
  compress: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

/** 取整数选项，顺手把 --port abc 这类错误挡在启动之前。 */
function int(name, value, { min = 1, max = 65535 } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} 应为 ${min}~${max} 的整数，收到 "${value}"`);
  }
  return n;
}

/**
 * 把 --url 拦下来先检一道：不合法的地址交给 new WebSocket() 会直接抛个 SyntaxError 堆栈出来。
 *
 * 最容易踩的坑是把端口写进了 IPv6 的方括号里（[地址:端口]），这里单独提醒一句。
 */
function checkUrl(url) {
  if (!/^wss?:\/\//.test(url)) throw new Error('--url 必须以 ws:// 或 wss:// 开头');
  try {
    new URL(url);
  } catch {
    const inner = /^wss?:\/\/\[([^\]]*)\]/.exec(url)?.[1];
    const hint =
      inner && inner.split(':').length > 8
        ? `方括号里的 "${inner}" 有 ${inner.split(':').length} 组，IPv6 最多 8 组 —— 端口是不是误写到方括号里面了？`
        : 'IPv6 地址要写成 ws://[地址]:端口/路径，端口必须在方括号外面';
    throw new Error(`--url 不是合法的地址："${url}"\n  ${hint}`);
  }
}

/**
 * 接法：给了 --url 就是拨号，否则监听（--port 默认 8080）。
 *
 * 两个都给属于自相矛盾，直接报错，别让人以为自己配了个双向的东西。
 */
function parseTransport(values) {
  if (values.url) {
    if (values.port !== undefined) {
      throw new Error('--port 与 --url 只能给一个：--port 是自己监听等对端来接，--url 是主动去接对端');
    }
    if (values.host !== undefined) throw new Error('--host 只在监听（--port）时有意义，拨号请把地址写进 --url');
    if (values.path !== undefined) throw new Error('--path 只在监听（--port）时有意义，拨号请把路径写进 --url');
    checkUrl(values.url);
    return {
      kind: 'dial',
      url: values.url,
      insecure: values.insecure,
      retryMin: int('--retry-min', values['retry-min'] ?? '1000', { min: 1, max: 600_000 }),
      retryMax: int('--retry-max', values['retry-max'] ?? '30000', { min: 1, max: 600_000 }),
    };
  }

  const path = values.path ?? '/tunnel';
  return {
    kind: 'listen',
    port: int('--port', values.port ?? '8080'),
    host: values.host ?? '::',
    path: path.startsWith('/') ? path : `/${path}`,
    publicHttp: values['public-http'],
  };
}

/** 两种模式共用的部分。 */
function common(values) {
  return {
    transport: parseTransport(values),
    token: values.token ?? process.env.TUNNEL_TOKEN ?? '',
    compress: values.compress,
    verbose: values.verbose,
  };
}

function parseAccess(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      map: { type: 'string', multiple: true, default: [] },
      'listen-host': { type: 'string', default: '127.0.0.1' },
    },
  });

  if (values.help) return null;
  if (values.map.length === 0) {
    throw new Error('至少需要一个 --map 参数，例如 --map 5000=web（web 是 expose 端声明的服务名）');
  }

  const mappings = values.map.map(parseMapping);
  const seen = new Set();
  for (const m of mappings) {
    if (seen.has(m.listenPort)) throw new Error(`本地端口 ${m.listenPort} 被 --map 用了两次`);
    seen.add(m.listenPort);
  }

  return { role: 'access', ...common(values), mappings, listenHost: values['listen-host'] };
}

function parseExpose(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      expose: { type: 'string', multiple: true, default: [] },
      'connect-timeout': { type: 'string', default: '10000' },
    },
  });

  if (values.help) return null;
  if (values.expose.length === 0) {
    throw new Error('至少需要一个 --expose 参数，例如 --expose web=127.0.0.1:9000');
  }

  const services = values.expose.map(parseService);
  const seen = new Set();
  for (const s of services) {
    if (seen.has(s.name)) throw new Error(`服务名 "${s.name}" 被 --expose 声明了两次`);
    seen.add(s.name);
  }

  return {
    role: 'expose',
    ...common(values),
    services,
    connectTimeout: int('--connect-timeout', values['connect-timeout'], { min: 1, max: 600_000 }),
  };
}

const PARSERS = { access: parseAccess, expose: parseExpose };

function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (!first || first === '--help' || first === '-h' || first === 'help') {
    process.stdout.write(`${TOP_HELP}\n`);
    process.exit(0);
  }
  if (first === '--version' || first === '-v' || first === 'version') {
    process.stdout.write(`${NAME} ${VERSION}\n`);
    process.exit(0);
  }
  if (!MODES.includes(first)) {
    process.stderr.write(
      `未知的模式 "${first}"。可用模式：${MODES.join(' / ')}\n用 ${NAME} --help 查看用法。\n`,
    );
    process.exit(1);
  }

  let opts;
  try {
    opts = PARSERS[first](argv.slice(1));
  } catch (err) {
    process.stderr.write(`参数错误：${err.message}\n用 ${NAME} ${first} --help 查看用法。\n`);
    process.exit(1);
  }

  if (!opts) {
    // 走到这里说明带了 --help
    process.stdout.write(`${modeHelp(first)}\n`);
    process.exit(0);
  }

  RUNNERS[first](opts);
}

main();
