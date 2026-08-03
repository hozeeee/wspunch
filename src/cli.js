#!/usr/bin/env node
'use strict';

/**
 * 命令行入口：解析 `子命令 + 选项`，然后把归一化后的配置交给对应模式。
 *
 *   wsfwd access --port 8080 --map 5000:127.0.0.1:22 --token xxx
 *   wsfwd expose --url ws://1.2.3.4:8080/tunnel --token xxx
 */

const { parseArgs } = require('node:util');

const { NAME, VERSION } = require('./buildinfo');
const { modeHelp, TOP_HELP } = require('./usage');
const { parseMapping } = require('./lib/util');

// 静态 require，别写成 require(`./modes/${mode}`) —— 那样 esbuild 打包时分析不到
const RUNNERS = {
  access: require('./modes/access').run,
  expose: require('./modes/expose').run,
};
const MODES = Object.keys(RUNNERS);

/** 取整数选项，顺手把 --port abc 这类错误挡在启动之前。 */
function int(name, value, { min = 1, max = 65535 } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} 应为 ${min}~${max} 的整数，收到 "${value}"`);
  }
  return n;
}

function parseAccess(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: '8080' },
      host: { type: 'string', default: '::' },
      path: { type: 'string', default: '/tunnel' },
      map: { type: 'string', multiple: true, default: [] },
      'listen-host': { type: 'string', default: '127.0.0.1' },
      token: { type: 'string' },
      'public-http': { type: 'boolean', default: false },
      compress: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) return null;
  if (values.map.length === 0) {
    throw new Error('至少需要一个 --map 参数，例如 --map 5000:127.0.0.1:22');
  }

  return {
    port: int('--port', values.port),
    host: values.host,
    path: values.path.startsWith('/') ? values.path : `/${values.path}`,
    mappings: values.map.map(parseMapping),
    listenHost: values['listen-host'],
    token: values.token ?? process.env.TUNNEL_TOKEN ?? '',
    publicHttp: values['public-http'],
    compress: values.compress,
    verbose: values.verbose,
  };
}

function parseExpose(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      token: { type: 'string' },
      'connect-timeout': { type: 'string', default: '10000' },
      'retry-min': { type: 'string', default: '1000' },
      'retry-max': { type: 'string', default: '30000' },
      insecure: { type: 'boolean', default: false },
      compress: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) return null;
  if (!values.url) throw new Error('必须指定 --url，例如 --url ws://1.2.3.4:8080/tunnel');
  if (!/^wss?:\/\//.test(values.url)) throw new Error('--url 必须以 ws:// 或 wss:// 开头');

  return {
    url: values.url,
    token: values.token ?? process.env.TUNNEL_TOKEN ?? '',
    connectTimeout: int('--connect-timeout', values['connect-timeout'], { min: 1, max: 600_000 }),
    retryMin: int('--retry-min', values['retry-min'], { min: 1, max: 600_000 }),
    retryMax: int('--retry-max', values['retry-max'], { min: 1, max: 600_000 }),
    insecure: values.insecure,
    compress: values.compress,
    verbose: values.verbose,
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
