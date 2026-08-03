'use strict';

/**
 * 两端共用的「接法」：那条 WS 长连接到底是怎么建起来的。
 *
 * 角色（expose / access）和接法（谁监听、谁拨号）是两件独立的事：
 *
 *   --port <n>   监听：起一个 http.Server，WS 服务与 HTTP 路由共用这个端口，等对端来接；
 *   --url <ws>   拨号：主动去接对端的 WS 服务，断了指数退避 + 抖动自动重连。
 *
 * 所以四种组合都能跑：expose 监听 / expose 拨号 / access 监听 / access 拨号。
 * 一对里必须一个监听一个拨号，谁监听就取决于哪台机器能被对方摸到。
 *
 * 同一时刻只保留一条 WS（新连接顶掉旧的）；拿到 ws 之后由上层 onPeer 自己 new Tunnel。
 */

const http = require('node:http');
const ws = require('ws');

const { NAME } = require('../buildinfo');
const { createHttpHandler } = require('../http-routes');
const { formatHostPort, safeEqual, getPublicAddresses } = require('./util');

const WebSocket = ws;
const { WebSocketServer } = ws;

const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD = 4 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** 心跳：对端两个周期内不回 pong 就当它死了。 */
function watchdog(sock, log, label) {
  sock.isAlive = true;
  sock.on('pong', () => {
    sock.isAlive = true;
  });
  const timer = setInterval(() => {
    if (!sock.isAlive) {
      log.warn(`${label} 心跳超时，主动断开`);
      sock.terminate();
      return;
    }
    sock.isAlive = false;
    sock.ping();
  }, HEARTBEAT_MS);
  sock.once('close', () => clearInterval(timer));
}

/**
 * 建立并维持与对端的 WS 连接。
 *
 * @param opts        归一化后的配置，opts.transport 决定监听还是拨号
 * @param log         日志器
 * @param onPeer      (ws, label) => Tunnel，上层在这里建隧道并做角色相关的初始化
 * @param onShutdown  收到退出信号时的额外收尾（比如关掉 TCP 监听）
 * @returns { tunnel }  当前在线的隧道，没有对端时为 null
 */
function startLink({ opts, log, onPeer, onShutdown }) {
  const t = opts.transport;

  /** 当前在线的对端，同一时刻只保留一条。 */
  let peer = null;

  const getState = () => ({
    role: opts.role,
    peerConnected: Boolean(peer),
    streams: peer ? peer.tunnel.streamCount : 0,
  });

  const adopt = (sock, label) => {
    if (peer) {
      log.warn(`对端重新接入（${label}），断开旧连接 ${peer.label}`);
      peer.ws.close(4000, 'replaced by a new peer');
    }
    const tunnel = onPeer(sock, label);
    const current = { ws: sock, tunnel, label };
    peer = current;
    watchdog(sock, log, `对端 ${label}`);
    sock.once('close', () => {
      if (peer === current) peer = null;
    });
  };

  // ------------------------------------------------------------ 监听（--port）
  let closeTransport = () => {};

  if (t.kind === 'listen') {
    // 绑在通配地址上时，日志与说明页里写回环，免得打出 [::]:8080 这种没法直接用的串
    const wildcard = t.host === '::' || t.host === '0.0.0.0';
    opts.publicAuthority = formatHostPort(wildcard ? '127.0.0.1' : t.host, t.port);

    const server = http.createServer(createHttpHandler({ opts, log, getState }));

    const wss = new WebSocketServer({
      server,
      path: t.path,
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

    wss.on('connection', (sock, req) => {
      const label = formatHostPort(req.socket.remoteAddress, req.socket.remotePort);
      log.info(`对端已接入：${label}`);
      adopt(sock, label);
      sock.on('error', (err) => log.error(`WS 出错（${label}）：${err.message}`));
      sock.on('close', (code, reason) => {
        log.info(`对端断开：${label}（code=${code}${reason?.length ? ` reason=${reason}` : ''}）`);
      });
    });

    wss.on('error', (err) => log.error(`WS 服务出错：${err.message}`));

    server.listen(t.port, t.host, () => {
      const bound = formatHostPort(t.host, t.port);
      const q = opts.token && !t.publicHttp ? '?token=你的口令' : '';
      log.info(`服务已启动：ws://${bound}${t.path}（WS） + http://${bound}/（说明与下载）`);
      log.info(`引导对端：curl -fsSL 'http://${opts.publicAuthority}/download${q}' -o ${NAME}`);

      // 异步获取并打印 IP 地址，失败不影响服务运行
      getPublicAddresses().then(({ ipv6Public, ipv4Public, ipv4Local }) => {
        const parts = [];
        if (ipv6Public) parts.push(`IPv6 公网: ${ipv6Public}`);
        if (ipv4Public) parts.push(`IPv4 公网: ${ipv4Public}`);
        if (ipv4Local) parts.push(`局域网 IPv4: ${ipv4Local}`);
        if (parts.length > 0) {
          log.info(`本机地址：\n${parts.join('\n')}`);
        } else {
          log.warn('无法获取本机公网地址（网络可能受限）');
        }
      }).catch(() => {
        // 获取失败不影响服务运行
      });
    });
    server.on('error', (err) => {
      log.error(`服务无法启动：${err.message}`);
      process.exit(1);
    });

    closeTransport = () => {
      if (peer) peer.ws.close(1001, 'server shutting down');
      wss.close();
      server.close();
    };
  } else {
    // ---------------------------------------------------------- 拨号（--url）
    let retryDelay = t.retryMin;
    let stopped = false;

    // 重连等待期间进程不能退出，用一个长定时器兜住事件循环
    const alive = setInterval(() => {}, 60_000);

    const connect = () => {
      if (stopped) return;
      log.info(`正在接入对端：${t.url}`);

      let sock;
      try {
        sock = new WebSocket(t.url, {
          headers: opts.token ? { 'x-tunnel-token': opts.token } : {},
          perMessageDeflate: opts.compress,
          maxPayload: MAX_PAYLOAD,
          rejectUnauthorized: !t.insecure,
          handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        });
      } catch (err) {
        // 地址本身不合法之类的同步抛错，重试多少次都是同一个结果，直接说清楚再退出
        log.error(`无法按 --url 建立连接：${err.message}`);
        clearInterval(alive);
        process.exit(1);
      }

      sock.on('open', () => {
        retryDelay = t.retryMin; // 连上就把退避重置
        log.info('已接入对端');
        adopt(sock, t.url);
      });

      sock.on('unexpected-response', (_req, res) => {
        log.error(`握手被拒绝：HTTP ${res.statusCode}${res.statusCode === 401 ? '（口令不正确？）' : ''}`);
        sock.terminate();
      });

      sock.on('error', (err) => log.error(`WS 出错：${err.message}`));

      sock.on('close', (code, reason) => {
        if (stopped) return;
        const text = reason?.length ? ` reason=${reason}` : '';
        log.warn(`与对端的连接已断开（code=${code}${text}），${retryDelay}ms 后重连`);
        const timer = setTimeout(connect, retryDelay);
        timer.unref?.();
        // 指数退避 + 抖动，避免对端重启时一堆客户端同时打过来
        retryDelay = Math.min(Math.floor(retryDelay * 1.7 + Math.random() * 300), t.retryMax);
      });
    };

    closeTransport = () => {
      stopped = true;
      clearInterval(alive);
      if (peer) peer.ws.close(1001, 'client shutting down');
    };

    connect();
  }

  // ---------------------------------------------------------------- 退出
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    log.info(`收到 ${signal}，正在退出…`);
    if (onShutdown) onShutdown();
    closeTransport();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return {
    get tunnel() {
      return peer ? peer.tunnel : null;
    },
  };
}

module.exports = { startLink };
