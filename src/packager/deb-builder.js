import { Adapter } from './adapter';

const makeCrcTable = () => {
  const cTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    cTable[n] = c;
  }
  return cTable;
};
const crcTable = makeCrcTable();
const crc32 = (buf) => {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const gzipStored = (data) => {
  const header = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);
  const footer = new Uint8Array(8);
  const fView = new DataView(footer.buffer);
  fView.setUint32(0, crc32(data), true);
  fView.setUint32(4, data.length >>> 0, true);

  const chunkSize = 65535;
  const numChunks = Math.ceil(data.length / chunkSize) || 1;
  const chunks = [];
  let totalBlocksLen = 0;

  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, data.length);
    const chunkData = data.subarray(start, end);
    const len = chunkData.length;
    const isLast = i === numChunks - 1;

    const blockHeader = new Uint8Array(5);
    blockHeader[0] = isLast ? 0x01 : 0x00;
    blockHeader[1] = len & 0xff;
    blockHeader[2] = (len >> 8) & 0xff;
    const nlen = len ^ 0xffff;
    blockHeader[3] = nlen & 0xff;
    blockHeader[4] = (nlen >> 8) & 0xff;

    chunks.push(blockHeader);
    chunks.push(chunkData);
    totalBlocksLen += 5 + len;
  }

  const result = new Uint8Array(header.length + totalBlocksLen + footer.length);
  result.set(header, 0);
  let offset = header.length;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  result.set(footer, offset);
  return result;
};

export const gzipCompress = async (data) => {
  if (typeof CompressionStream !== 'undefined') {
    try {
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      writer.write(data);
      writer.close();
      const chunks = [];
      const reader = cs.readable.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
      const result = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    } catch (e) {
      console.warn('CompressionStream failed, using fallback:', e);
    }
  }
  return gzipStored(data);
};

const encoder = new TextEncoder();

export const createTarArchive = (files) => {
  const blocks = [];

  for (const file of files) {
    const header = new Uint8Array(512);

    // Name (0..99) — strip leading './' and skip empty root names
    const memberName = file.name.replace(/^\.\//, '');
    if (memberName.length === 0) continue; // skip root './' entries
    const nameBytes = encoder.encode(memberName);
    header.set(nameBytes.subarray(0, 100), 0);

    // Mode (100..107)
    const modeStr = (file.mode || (file.isDir ? 0o755 : 0o644)).toString(8).padStart(7, '0') + '\0';
    header.set(encoder.encode(modeStr), 100);

    // UID / GID (108..123)
    header.set(encoder.encode('0000000\0'), 108);
    header.set(encoder.encode('0000000\0'), 116);

    // Size (124..135)
    const size = file.isDir ? 0 : (file.data ? file.data.length : 0);
    const sizeStr = size.toString(8).padStart(11, '0') + '\0';
    header.set(encoder.encode(sizeStr), 124);

    // Mtime (136..147)
    const mtimeStr = '00000000000\0';
    header.set(encoder.encode(mtimeStr), 136);

    // Checksum placeholder (148..155): 8 spaces
    header.fill(0x20, 148, 156);

    // Typeflag (156)
    header[156] = file.isDir ? 0x35 /* '5' */ : 0x30 /* '0' */;

    // Magic (257..262) & Version (263..264)
    header.set(encoder.encode('ustar\0'), 257);
    header.set(encoder.encode('00'), 263);

    // Uname / Gname (265..328)
    header.set(encoder.encode('root\0'), 265);
    header.set(encoder.encode('root\0'), 297);

    // Compute checksum
    let chksum = 0;
    for (let i = 0; i < 512; i++) {
      chksum += header[i];
    }
    const chkStr = chksum.toString(8).padStart(6, '0') + '\0 ';
    header.set(encoder.encode(chkStr), 148);

    blocks.push(header);

    if (!file.isDir && file.data && file.data.length > 0) {
      blocks.push(file.data);
      const pad = (512 - (file.data.length % 512)) % 512;
      if (pad > 0) {
        blocks.push(new Uint8Array(pad));
      }
    }
  }

  // End of archive: 2 zero blocks (1024 bytes)
  blocks.push(new Uint8Array(1024));

  const totalLength = blocks.reduce((acc, b) => acc + b.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const b of blocks) {
    result.set(b, offset);
    offset += b.length;
  }
  return result;
};

const padString = (str, length) => str.padEnd(length, ' ');

export async function buildDeb(electronZip, options) {
  const packageName = options.app.packageName;
  const version = options.app.version || '1.0.0';
  const arch = options.target.includes('arm64') ? 'arm64' : 'amd64';
  const maintainer = (options.linuxPackage && options.linuxPackage.maintainer) || 'HyperWarp Developer <developer@hyperwarp.org>';
  const section = (options.linuxPackage && options.linuxPackage.section) || 'games';
  const description = (options.linuxPackage && options.linuxPackage.description) || 'Packaged project using HyperWarp Packager';
  const title = options.app.windowTitle || packageName;

  // 1. Build control tar.gz
  const controlText = [
    `Package: ${packageName}`,
    `Version: ${version}`,
    `Architecture: ${arch}`,
    `Maintainer: ${maintainer}`,
    `Section: ${section}`,
    `Priority: optional`,
    `Description: ${description}`,
    ''
  ].join('\n');

  const controlTar = createTarArchive([
    {
      name: './control',
      data: encoder.encode(controlText),
      mode: 0o644,
      isDir: false
    }
  ]);
  const controlTarGz = await gzipCompress(controlTar);

  // 2. Build data tar.gz
  const dataFiles = [
    { name: './', isDir: true, mode: 0o755 },
    { name: './opt/', isDir: true, mode: 0o755 },
    { name: `./opt/${packageName}/`, isDir: true, mode: 0o755 },
    { name: './usr/', isDir: true, mode: 0o755 },
    { name: './usr/bin/', isDir: true, mode: 0o755 },
    { name: './usr/share/', isDir: true, mode: 0o755 },
    { name: './usr/share/applications/', isDir: true, mode: 0o755 },
    { name: './usr/share/pixmaps/', isDir: true, mode: 0o755 }
  ];

  // Copy files from electronZip
  const zipFiles = Object.keys(electronZip.files);
  for (const path of zipFiles) {
    const file = electronZip.files[path];
    if (file.dir) continue;

    let relPath = path;
    if (relPath.startsWith(`${packageName}/`)) {
      relPath = relPath.substring(packageName.length + 1);
    }
    if (!relPath) continue;

    const data = await file.async('uint8array');
    const isExecutable = relPath === packageName || relPath.endsWith('.so') || relPath === 'chrome-sandbox';
    dataFiles.push({
      name: `./opt/${packageName}/${relPath}`,
      data,
      mode: isExecutable ? 0o755 : 0o644,
      isDir: false
    });
  }

  // Launcher script under /usr/bin/<packageName>
  const launcherScript = `#!/bin/sh\nexec /opt/${packageName}/${packageName} "$@"\n`;
  dataFiles.push({
    name: `./usr/bin/${packageName}`,
    data: encoder.encode(launcherScript),
    mode: 0o755,
    isDir: false
  });

  // Desktop file under /usr/share/applications/<packageName>.desktop
  const desktopContent = [
    '[Desktop Entry]',
    `Name=${title}`,
    `Exec=/opt/${packageName}/${packageName} %U`,
    'Terminal=false',
    'Type=Application',
    `Icon=${packageName}`,
    `Categories=${section};`,
    `Comment=${description}`,
    ''
  ].join('\n');
  dataFiles.push({
    name: `./usr/share/applications/${packageName}.desktop`,
    data: encoder.encode(desktopContent),
    mode: 0o644,
    isDir: false
  });

  // Icon under /usr/share/pixmaps/<packageName>.png
  let iconData = null;
  try {
    iconData = await Adapter.getAppIcon(options.app.icon);
  } catch (e) {
    // ignore
  }
  if (!iconData) {
    iconData = new Uint8Array(0);
  }
  dataFiles.push({
    name: `./usr/share/pixmaps/${packageName}.png`,
    data: iconData,
    mode: 0o644,
    isDir: false
  });

  const dataTar = createTarArchive(dataFiles);
  const dataTarGz = await gzipCompress(dataTar);

  // 3. Assemble ar archive
  const arMagic = encoder.encode('!<arch>\n');
  const debianBinary = encoder.encode('2.0\n');

  const makeArHeader = (filename, size) => {
    const h = new Uint8Array(60);
    h.set(encoder.encode(padString(filename, 16)), 0);
    h.set(encoder.encode(padString('0', 12)), 16);
    h.set(encoder.encode(padString('0', 6)), 28);
    h.set(encoder.encode(padString('0', 6)), 34);
    h.set(encoder.encode(padString('100644', 8)), 40);
    h.set(encoder.encode(padString(String(size), 10)), 48);
    h[58] = 0x60;
    h[59] = 0x0a;
    return h;
  };

  const parts = [
    arMagic,
    makeArHeader('debian-binary', debianBinary.length),
    debianBinary,
    makeArHeader('control.tar.gz', controlTarGz.length),
    controlTarGz
  ];
  if (controlTarGz.length % 2 !== 0) {
    parts.push(new Uint8Array([0x0a]));
  }
  parts.push(makeArHeader('data.tar.gz', dataTarGz.length));
  parts.push(dataTarGz);
  if (dataTarGz.length % 2 !== 0) {
    parts.push(new Uint8Array([0x0a]));
  }

  const totalDebLen = parts.reduce((acc, p) => acc + p.length, 0);
  const debBuffer = new Uint8Array(totalDebLen);
  let offset = 0;
  for (const p of parts) {
    debBuffer.set(p, offset);
    offset += p.length;
  }

  return debBuffer;
}
