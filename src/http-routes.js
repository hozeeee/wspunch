'use strict';

/**
 * access 端的 HTTP 路由。与 WS 服务共用同一个端口、同一个 http.Server，
 * 所以对外只需要放开一个端口。
 *
 *   GET /                 使用说明，引导命令里会填好本机真实地址
 *   GET /download         下发这个脚本本身，给对端拿去跑 expose 模式
 *   GET /download.sha256  上面那个文件的校验和
 *   GET /healthz          探活，永不鉴权（挂在网关后面用）
 *
 * 设了 --token 时，说明页与下载路由也要带口令（--public-http 可放开）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { BUNDLED, NAME } = require('./buildinfo');
const { httpUsage } = require('./usage');
const { safeEqual } = require('./lib/util');

const TEXT = { 'content-type': 'text/plain; charset=utf-8' };

/**
 * 可下发给对端的单文件脚本。打包产物里，这个文件就是自己；
 * 直接跑源码时退回 dist 下的构建产物（没有就提示先构建）。
 */
function selfBundlePath() {
  if (BUNDLED) return __filename;
  const built = path.join(__dirname, '..', 'dist', `${NAME}.js`);
  return fs.existsSync(built) ? built : null;
}

/** 校验和按 mtime + size 缓存，避免每次下载都重算。 */
let hashCache = null;
function sha256Of(file) {
  const { mtimeMs, size } = fs.statSync(file);
  if (hashCache && hashCache.file === file && hashCache.mtimeMs === mtimeMs && hashCache.size === size) {
    return hashCache.hex;
  }
  const hex = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  hashCache = { file, mtimeMs, size, hex };
  return hex;
}

function createHttpHandler({ opts, getState, log }) {
  const authRequired = Boolean(opts.token) && !opts.publicHttp;

  const authorized = (req, url) => {
    if (!authRequired) return true;
    const provided = req.headers['x-tunnel-token'] || url.searchParams.get('token') || '';
    return safeEqual(provided, opts.token);
  };

  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const head = req.method === 'HEAD';

    if (req.method !== 'GET' && !head) {
      res.writeHead(405, TEXT).end('只支持 GET\n');
      return;
    }

    // 探活不鉴权，方便挂在网关/监控后面
    if (pathname === '/healthz') {
      const state = getState();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(head ? undefined : `${JSON.stringify({ ok: true, ...state })}\n`);
      return;
    }

    if (!authorized(req, url)) {
      log.warn(`拒绝 ${req.socket.remoteAddress} 访问 ${pathname}：口令不正确`);
      res.writeHead(401, TEXT).end(
        head ? undefined : `需要口令：加上 ?token=你的口令，或带请求头 x-tunnel-token\n`,
      );
      return;
    }

    if (pathname === '/') {
      const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const authority = req.headers.host || opts.publicAuthority;
      const body = httpUsage({
        httpBase: `${proto}://${authority}`,
        wsUrl: `${proto === 'https' ? 'wss' : 'ws'}://${authority}${opts.path}`,
        hasToken: Boolean(opts.token),
        tokenInUrl: authRequired,
        mappings: opts.mappings,
      });
      res.writeHead(200, TEXT).end(head ? undefined : body);
      return;
    }

    if (pathname === '/download' || pathname === '/download.sha256') {
      const file = selfBundlePath();
      if (!file) {
        res.writeHead(501, TEXT).end(
          head
            ? undefined
            : '当前跑的是源码而不是打包产物，没有可下发的单文件脚本。\n请先在源码目录执行 npm run build，再重启本进程。\n',
        );
        return;
      }

      if (pathname === '/download.sha256') {
        res.writeHead(200, TEXT).end(head ? undefined : `${sha256Of(file)}  ${NAME}\n`);
        return;
      }

      const { size } = fs.statSync(file);
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'content-disposition': `attachment; filename="${NAME}"`,
        'content-length': String(size),
      });
      if (head) {
        res.end();
        return;
      }
      log.info(`${req.socket.remoteAddress} 正在下载脚本（${size} 字节）`);
      fs.createReadStream(file).pipe(res);
      return;
    }

    res.writeHead(404, TEXT).end(head ? undefined : '没有这个路由，看 GET / 的说明\n');
  };
}

module.exports = { createHttpHandler, selfBundlePath };
