'use strict';

/**
 * access 模式 —— 跑在你能直接访问的机器上（公网 VPS / 本机）。
 *
 * 三件事：
 *   1. 起一个 http.Server，上面同时挂 WS 服务（等 expose 端来接）和 HTTP 路由
 *      （使用说明 + 下发脚本 + 探活），两者共用一个端口；
 *   2. 起若干 TCP 监听端口，把端口上的流量通过 WS 送给 expose 端；
 *   3. 把 expose 端回来的流量写回这些 TCP 连接。
 */

const http = require('node:http');
const net = require('node:net');
const { WebSocketServer } = require('ws');

const { NAME } = require('../buildinfo');
const { createHttpHandler } = require('../http-routes');
const { Tunnel } = require('../lib/tunnel');
const { createLogger, formatHostPort, safeEqual } = require('../lib/util');

const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD = 4 * 1024 * 1024;

function run(opts) {
  const log = createLogger('access', opts.verbose);
  if (!opts.token) {
    log.warn('未设置 --token，任何人都能接入这个 WS 服务并把本机当跳板，仅建议在本地实验时这样用');
  }

  /** 当前在线的 expose 端（同一时刻只保留一条，后来者顶掉前任）。 */
  let peer = null; // { ws, tunnel, label }

  // 对端看到的地址：绑在通配地址上时日志里写回环，免得打出 [::]:8080 这种没法直接用的串
  const wildcard = opts.host === '::' || opts.host === '0.0.0.0';
  opts.publicAuthority = formatHostPort(wildcard ? '127.0.0.1' : opts.host, opts.port);

  // -------------------------------------------------------- HTTP + WS 服务
  const server = http.createServer(
    createHttpHandler({
      opts,
      log,
      getState: () => ({ peerConnected: Boolean(peer), streams: peer ? peer.tunnel.streamCount : 0 }),
    }),
  );

  const wss = new WebSocketServer({
    server,
    path: opts.path,
    maxPayload: MAX_PAYLOAD,
    perMessageDeflate: opts.compress,
    verifyClient: ({ req }, done) => {
      if (!opts.token) return done(true);
      const url = new URL(req.url, 'http://localhost');
      const provided = req.headers['x-tunnel-token'] || url.searchParams.get('token') || '';
      if (safeEqual(provided, opts.token)) return done(true);
      log.warn(`拒绝来自 ${req.socket.remoteAddress} 的接入：口令不正确`);
      done(false, 401, 'Unauthorized');
    },
  });

  wss.on('connection', (ws, req) => {
    const label = formatHostPort(req.socket.remoteAddress, req.socket.remotePort);
    if (peer) {
      log.warn(`expose 端重新接入（${label}），断开旧连接 ${peer.label}`);
      peer.ws.close(4000, 'replaced by a new peer');
    }

    const tunnel = new Tunnel(ws, { log });
    const current = { ws, tunnel, label };
    peer = current;
    log.info(`expose 端已接入：${label}`);

    // 心跳：对端两个周期内不回 pong 就当它死了
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    const heartbeat = setInterval(() => {
      if (!ws.isAlive) {
        log.warn(`expose 端 ${label} 心跳超时，主动断开`);
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    }, HEARTBEAT_MS);

    ws.on('close', (code, reason) => {
      clearInterval(heartbeat);
      tunnel.destroy(new Error('expose 端已断开'));
      if (peer === current) peer = null;
      log.info(`expose 端断开：${label}（code=${code}${reason?.length ? ` reason=${reason}` : ''}）`);
    });
    ws.on('error', (err) => log.error(`WS 出错（${label}）：${err.message}`));
  });

  wss.on('error', (err) => log.error(`WS 服务出错：${err.message}`));

  server.listen(opts.port, opts.host, () => {
    const bound = formatHostPort(opts.host, opts.port);
    const q = opts.token && !opts.publicHttp ? '?token=你的口令' : '';
    log.info(`服务已启动：ws://${bound}${opts.path}（WS） + http://${bound}/（说明与下载）`);
    log.info(`引导对端：curl -fsSL 'http://${opts.publicAuthority}/download${q}' -o ${NAME}`);
  });
  server.on('error', (err) => {
    log.error(`服务无法启动：${err.message}`);
    process.exit(1);
  });

  // -------------------------------------------------------- TCP 端口监听
  const tcpServers = opts.mappings.map((m) => {
    const srv = net.createServer({ allowHalfOpen: true }, (socket) => {
      const from = formatHostPort(socket.remoteAddress, socket.remotePort);
      if (!peer) {
        log.warn(`来自 ${from} 的连接被丢弃：expose 端尚未接入`);
        socket.destroy();
        return;
      }
      const id = peer.tunnel.open(socket, m.target);
      log.info(`${from} -> 本地:${m.listenPort} 建流 #${id}，目标 ${m.target}`);
    });

    srv.on('error', (err) => {
      log.error(`端口 ${m.listenPort} 监听失败：${err.message}`);
      process.exit(1);
    });
    srv.listen(m.listenPort, opts.listenHost, () => {
      log.info(`端口转发已就绪：${formatHostPort(opts.listenHost, m.listenPort)}  ==ws==>  ${m.target}`);
    });
    return srv;
  });

  // ---------------------------------------------------------------- 退出
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    log.info(`收到 ${signal}，正在退出…`);
    for (const srv of tcpServers) srv.close();
    if (peer) peer.ws.close(1001, 'server shutting down');
    wss.close();
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { run };
