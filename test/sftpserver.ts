import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;
const STATUS = utils.sftp.STATUS_CODE;
const FLAGS = utils.sftp.OPEN_MODE;

export interface FakeSftp {
  host: string;
  port: number;
  root: string;
  fingerprint: string;
  logins: { username: string; ok: boolean }[];
  close(): Promise<void>;
}

function attrs(st: fs.Stats) {
  return { mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
}

export async function startFakeSftp(root: string, username = 'player.abc123', password = 'secret'): Promise<FakeSftp> {
  const key = utils.generateKeyPairSync('ed25519');
  const parsed = utils.parseKey(key.private);
  const pub = (Array.isArray(parsed) ? parsed[0] : parsed) as { getPublicSSH(): Buffer };
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(pub.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  const logins: FakeSftp['logins'] = [];
  const resolve = (p: string) => {
    const rel = path.posix.normalize(`/${p.replace(/\\/g, '/')}`);
    return path.join(root, ...rel.split('/').filter(Boolean));
  };
  const server = new Server({ hostKeys: [key.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        const ok = ctx.username === username && ctx.password === password;
        logins.push({ username: ctx.username, ok });
        return ok ? ctx.accept() : ctx.reject(['password']);
      }
      ctx.reject(['password']);
    });
    client.on('error', () => undefined);
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<number, { fd?: number; dir?: string; done?: boolean }>();
          let next = 1;
          const handle = (h: Buffer) => handles.get(h.readUInt32BE(0));
          const newHandle = (v: { fd?: number; dir?: string }) => {
            const id = next++;
            handles.set(id, v);
            const b = Buffer.alloc(4);
            b.writeUInt32BE(id, 0);
            return b;
          };
          const fail = (reqid: number, e: NodeJS.ErrnoException) => sftp.status(reqid, e.code === 'ENOENT' ? STATUS.NO_SUCH_FILE : e.code === 'EACCES' ? STATUS.PERMISSION_DENIED : STATUS.FAILURE, e.message);
          sftp.on('REALPATH', (reqid, p) => {
            const rel = path.posix.normalize(`/${p}`);
            sftp.name(reqid, [{ filename: rel, longname: rel, attrs: {} as never }]);
          });
          const stat = (reqid: number, p: string) => {
            try {
              sftp.attrs(reqid, attrs(fs.statSync(resolve(p))));
            } catch (e) {
              fail(reqid, e as NodeJS.ErrnoException);
            }
          };
          sftp.on('STAT', stat);
          sftp.on('LSTAT', stat);
          sftp.on('FSTAT', (reqid, h) => {
            const v = handle(h);
            if (v?.fd === undefined) return sftp.status(reqid, STATUS.FAILURE);
            sftp.attrs(reqid, attrs(fs.fstatSync(v.fd)));
          });
          sftp.on('OPEN', (reqid, p, flags) => {
            try {
              let mode = 'r';
              if (flags & FLAGS.WRITE) mode = flags & FLAGS.TRUNC || flags & FLAGS.CREAT ? 'w' : 'r+';
              if (flags & FLAGS.APPEND) mode = 'a';
              if (flags & FLAGS.READ && flags & FLAGS.WRITE && !(flags & FLAGS.TRUNC)) mode = fs.existsSync(resolve(p)) ? 'r+' : 'w+';
              sftp.handle(reqid, newHandle({ fd: fs.openSync(resolve(p), mode) }));
            } catch (e) {
              fail(reqid, e as NodeJS.ErrnoException);
            }
          });
          sftp.on('READ', (reqid, h, offset, length) => {
            const v = handle(h);
            if (v?.fd === undefined) return sftp.status(reqid, STATUS.FAILURE);
            const buf = Buffer.alloc(length);
            const n = fs.readSync(v.fd, buf, 0, length, offset);
            if (n === 0) return sftp.status(reqid, STATUS.EOF);
            sftp.data(reqid, buf.subarray(0, n));
          });
          sftp.on('WRITE', (reqid, h, offset, data) => {
            const v = handle(h);
            if (v?.fd === undefined) return sftp.status(reqid, STATUS.FAILURE);
            fs.writeSync(v.fd, data, 0, data.length, offset);
            sftp.status(reqid, STATUS.OK);
          });
          sftp.on('CLOSE', (reqid, h) => {
            const v = handle(h);
            if (v?.fd !== undefined) fs.closeSync(v.fd);
            handles.delete(h.readUInt32BE(0));
            sftp.status(reqid, STATUS.OK);
          });
          sftp.on('OPENDIR', (reqid, p) => {
            const dir = resolve(p);
            if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return sftp.status(reqid, STATUS.NO_SUCH_FILE);
            sftp.handle(reqid, newHandle({ dir }));
          });
          sftp.on('READDIR', (reqid, h) => {
            const v = handle(h);
            if (!v?.dir) return sftp.status(reqid, STATUS.FAILURE);
            if (v.done) return sftp.status(reqid, STATUS.EOF);
            v.done = true;
            sftp.name(reqid, fs.readdirSync(v.dir).map((n) => ({ filename: n, longname: n, attrs: attrs(fs.statSync(path.join(v.dir!, n))) as never })));
          });
          sftp.on('MKDIR', (reqid, p) => {
            try {
              fs.mkdirSync(resolve(p));
              sftp.status(reqid, STATUS.OK);
            } catch (e) {
              fail(reqid, e as NodeJS.ErrnoException);
            }
          });
          sftp.on('REMOVE', (reqid, p) => {
            try {
              fs.unlinkSync(resolve(p));
              sftp.status(reqid, STATUS.OK);
            } catch (e) {
              fail(reqid, e as NodeJS.ErrnoException);
            }
          });
          sftp.on('RMDIR', (reqid, p) => {
            try {
              fs.rmdirSync(resolve(p));
              sftp.status(reqid, STATUS.OK);
            } catch (e) {
              fail(reqid, e as NodeJS.ErrnoException);
            }
          });
          sftp.on('RENAME', (reqid, from, to) => {
            if (fs.existsSync(resolve(to))) return sftp.status(reqid, STATUS.FAILURE, 'target exists');
            try {
              fs.renameSync(resolve(from), resolve(to));
              sftp.status(reqid, STATUS.OK);
            } catch (e) {
              fail(reqid, e as NodeJS.ErrnoException);
            }
          });
          sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS.OK));
          sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS.OK));
        });
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { host: '127.0.0.1', port, root, fingerprint, logins, close: () => new Promise<void>((r) => server.close(() => r())) };
}
