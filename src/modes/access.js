'use strict';

/**
 * access 模式 —— 跑在你要用这些服务的那台机器上。
 *
 * 干两件事：
 *   1. 按 --map（`本地端口=服务名`）监听若干本地 TCP 端口，端口上来的流量按服务名
 *      通过 WS 送给 expose 端；
 *   2. 把 expose 端回来的流量写回这些 TCP 连接。
 *
 * 目标地址本端不配置，只认服务名 —— 具体连哪儿由 expose 端的 --expose 声明。
 *
 * 接法与角色无关：给 --port 就自己起服务等对端来接，给 --url 就主动去接对端。
 */

const net = require('node:net');

const { startLink } = require('../lib/link');
const { Tunnel } = require('../lib/tunnel');
const { createLogger, formatHostPort } = require('../lib/util');

function run(opts) {
  const log = createLogger('access', opts.verbose);
  if (!opts.token) {
    log.warn('未设置 --token，接入过程没有任何鉴权，仅建议在本地实验时这样用');
  }

  /** 当前对端连同它声明的服务清单，断开后置回 null。 */
  let active = null; // { tunnel, catalog: Map<name, target> | null }

  const link = startLink({
    opts,
    log,
    onPeer: (ws, label) => {
      const tunnel = new Tunnel(ws, { log });
      const current = { tunnel, catalog: null };
      active = current;

      tunnel.on('services', (list) => {
        current.catalog = new Map(list.map((s) => [s.name, s.target || '?']));
        const text = list.map((s) => `${s.name} -> ${s.target}`).join('，') || '（无）';
        log.info(`${label} 提供的服务：${text}`);
        for (const m of opts.mappings) {
          if (!current.catalog.has(m.service)) {
            log.error(`本地端口 ${m.listenPort} 要的服务 "${m.service}" 对端没有声明，这个端口上的连接会被拒绝`);
          }
        }
      });

      tunnel.once('close', () => {
        if (active === current) active = null;
      });

      return tunnel;
    },
    onShutdown: () => {
      for (const srv of tcpServers) srv.close();
    },
  });

  // -------------------------------------------------------- 本地 TCP 端口监听
  const tcpServers = opts.mappings.map((m) => {
    const srv = net.createServer({ allowHalfOpen: true }, (socket) => {
      const from = formatHostPort(socket.remoteAddress, socket.remotePort);
      const tunnel = link.tunnel;
      if (!tunnel) {
        log.warn(`来自 ${from} 的连接被丢弃：对端尚未接上`);
        socket.destroy();
        return;
      }
      // 清单已收到却没有这个名字，就没必要白跑一趟 WS 了
      if (active?.catalog && !active.catalog.has(m.service)) {
        log.warn(`来自 ${from} 的连接被丢弃：对端没有声明服务 "${m.service}"`);
        socket.destroy();
        return;
      }
      const id = tunnel.open(socket, m.service);
      log.info(`${from} -> 本地:${m.listenPort} 建流 #${id}，服务 ${m.service}`);
    });

    srv.on('error', (err) => {
      log.error(`端口 ${m.listenPort} 监听失败：${err.message}`);
      process.exit(1);
    });
    srv.listen(m.listenPort, opts.listenHost, () => {
      log.info(`端口转发已就绪：${formatHostPort(opts.listenHost, m.listenPort)}  ==ws==>  服务 ${m.service}`);
    });
    return srv;
  });
}

module.exports = { run };
