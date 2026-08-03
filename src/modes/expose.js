'use strict';

/**
 * expose 模式 —— 跑在真正能访问目标服务的那台机器上（通常在内网）。
 *
 * 两件事：
 *   1. 主动连上 access 端的 WebSocket 服务（断了自动重连）；
 *   2. 收到 access 端的建流请求后连到目标 host:port，
 *      然后在这条 TCP 连接和 WS 之间双向搬运数据。
 *
 * 目标由 access 端的 --map 决定，本端不配置目标 —— 口令就是唯一的信任边界。
 */

const net = require('node:net');
const { once } = require('node:events');
const WebSocket = require('ws');

const { Tunnel } = require('../lib/tunnel');
const { createLogger, parseHostPort } = require('../lib/util');

const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD = 4 * 1024 * 1024;

/** 连到目标地址，带超时；成功返回 socket。 */
async function connectTarget(host, port, timeoutMs) {
  const socket = net.connect({ host, port, allowHalfOpen: true });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`连接 ${host}:${port} 超时`)));
  await once(socket, 'connect');
  socket.setTimeout(0); // 连上之后不再限制空闲时间
  return socket;
}

function run(opts) {
  const log = createLogger('expose', opts.verbose);
  if (!opts.token) log.warn('未设置 --token，接入过程没有任何鉴权，仅建议在本地实验时这样用');

  let retryDelay = opts.retryMin;
  let current = null;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    log.info(`正在接入 access 端：${opts.url}`);

    const ws = new WebSocket(opts.url, {
      headers: opts.token ? { 'x-tunnel-token': opts.token } : {},
      perMessageDeflate: opts.compress,
      maxPayload: MAX_PAYLOAD,
      rejectUnauthorized: !opts.insecure,
      handshakeTimeout: 15_000,
    });
    current = ws;

    let heartbeat = null;

    ws.on('open', () => {
      retryDelay = opts.retryMin; // 连上就把退避重置
      log.info('已接入 access 端，等待转发请求');

      new Tunnel(ws, {
        log,
        onOpen: async (target) => {
          const { host, port } = parseHostPort(target);
          return connectTarget(host, port, opts.connectTimeout);
        },
      });

      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      heartbeat = setInterval(() => {
        if (!ws.isAlive) {
          log.warn('access 端心跳超时，断开重连');
          ws.terminate();
          return;
        }
        ws.isAlive = false;
        ws.ping();
      }, HEARTBEAT_MS);
    });

    ws.on('unexpected-response', (_req, res) => {
      log.error(`握手被拒绝：HTTP ${res.statusCode}${res.statusCode === 401 ? '（口令不正确？）' : ''}`);
      ws.terminate();
    });

    ws.on('error', (err) => log.error(`WS 出错：${err.message}`));

    ws.on('close', (code, reason) => {
      if (heartbeat) clearInterval(heartbeat);
      current = null;
      if (stopped) return;
      const text = reason?.length ? ` reason=${reason}` : '';
      log.warn(`与 access 端的连接已断开（code=${code}${text}），${retryDelay}ms 后重连`);
      const timer = setTimeout(connect, retryDelay);
      timer.unref?.();
      // 指数退避 + 抖动，避免 access 端重启时一堆 expose 端同时打过来
      retryDelay = Math.min(Math.floor(retryDelay * 1.7 + Math.random() * 300), opts.retryMax);
      // unref 之后要留一个 handle 防止进程直接退出
      keepAlive();
    });
  };

  // 重连等待期间进程不能退出，用一个长定时器兜住事件循环
  let alive = null;
  const keepAlive = () => {
    if (alive) return;
    alive = setInterval(() => {}, 60_000);
  };
  keepAlive();

  const shutdown = (signal) => {
    if (stopped) return;
    stopped = true;
    log.info(`收到 ${signal}，正在退出…`);
    if (alive) clearInterval(alive);
    if (current) current.close(1001, 'client shutting down');
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  connect();
}

module.exports = { run };
