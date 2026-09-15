#!/usr/bin/env node
/** Dependency-free ZIP writer: stored entries, fixed timestamp, deterministic path order. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { releaseFiles } from './release-files.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const table = Array.from({length:256}, (_, n) => { let c=n; for(let i=0;i<8;i++) c = c&1 ? 0xedb88320^(c>>>1) : c>>>1; return c>>>0; });
const crc32 = data => { let crc=0xffffffff; for(const x of data) crc=table[(crc^x)&255]^(crc>>>8); return (crc^0xffffffff)>>>0; };
const local = [], central = []; let offset=0;
for (const relative of releaseFiles(root)) {
  const name=Buffer.from(`pi/${relative}`), data=fs.readFileSync(path.join(root, relative)), crc=crc32(data);
  const h=Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20,4); h.writeUInt16LE(0x800,6);
  h.writeUInt16LE(0x21,12); h.writeUInt32LE(crc,14); h.writeUInt32LE(data.length,18); h.writeUInt32LE(data.length,22); h.writeUInt16LE(name.length,26);
  local.push(h,name,data);
  const c=Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x314,4); c.writeUInt16LE(20,6); c.writeUInt16LE(0x800,8);
  c.writeUInt16LE(0x21,14); c.writeUInt32LE(crc,16); c.writeUInt32LE(data.length,20); c.writeUInt32LE(data.length,24); c.writeUInt16LE(name.length,28);
  c.writeUInt32LE((0o100644 << 16) >>> 0,38); c.writeUInt32LE(offset,42); central.push(c,name); offset+=h.length+name.length+data.length;
}
const directory=Buffer.concat(central), end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length/2,8); end.writeUInt16LE(central.length/2,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
const zip=Buffer.concat([...local,directory,end]), dir=path.join(root,'dist'); fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'pi.zip'),zip);
const hash=crypto.createHash('sha256').update(zip).digest('hex'); fs.writeFileSync(path.join(dir,'SHA256SUMS'),`${hash}  pi.zip\n`);
console.log(JSON.stringify({archive:path.join(dir,'pi.zip'),sha256:hash,files:central.length/2,bytes:zip.length},null,2));
