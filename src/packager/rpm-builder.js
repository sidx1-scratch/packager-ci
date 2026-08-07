import { Adapter } from './adapter';
import { gzipCompress } from './deb-builder';

const encoder = new TextEncoder();

const toHex8 = (num) => (num >>> 0).toString(16).padStart(8, '0');

export const buildCpioArchive = (files) => {
  const chunks = [];
  let ino = 1;

  for (const file of files) {
    const isDir = file.isDir;
    const data = isDir ? new Uint8Array(0) : (file.data || new Uint8Array(0));
    const filesize = data.length;
    // Strip leading './' for cpio member names
    const memberName = file.name.replace(/^\.\//, '');
    const nameBytes = encoder.encode(memberName);
    const namesize = nameBytes.length + 1; // including \0

    const mode = file.mode || (isDir ? 0o40755 : 0o100644);
    const mtime = file.mtime || 0;
    const nlink = isDir ? 2 : 1;

    let headerStr = '070701';
    headerStr += toHex8(ino++);
    headerStr += toHex8(mode);
    headerStr += toHex8(0); // uid
    headerStr += toHex8(0); // gid
    headerStr += toHex8(nlink);
    headerStr += toHex8(mtime);
    headerStr += toHex8(filesize);
    headerStr += toHex8(3); // maj
    headerStr += toHex8(1); // min
    headerStr += toHex8(0); // rmaj
    headerStr += toHex8(0); // rmin
    headerStr += toHex8(namesize);
    headerStr += toHex8(0); // chksum

    const headerBytes = encoder.encode(headerStr); // 110 bytes
    chunks.push(headerBytes);

    const nameBuf = new Uint8Array(namesize);
    nameBuf.set(nameBytes, 0);
    nameBuf[nameBytes.length] = 0;
    chunks.push(nameBuf);

    // Align header + filename to 4 bytes
    const pad1 = (4 - ((110 + namesize) % 4)) % 4;
    if (pad1 > 0) {
      chunks.push(new Uint8Array(pad1));
    }

    if (filesize > 0) {
      chunks.push(data);
      const pad2 = (4 - (filesize % 4)) % 4;
      if (pad2 > 0) {
        chunks.push(new Uint8Array(pad2));
      }
    }
  }

  // Trailer entry
  const trailerName = encoder.encode('TRAILER!!!');
  const trailerNamesize = trailerName.length + 1; // 11
  let trailerHeaderStr = '070701';
  trailerHeaderStr += toHex8(0); // ino
  trailerHeaderStr += toHex8(0); // mode
  trailerHeaderStr += toHex8(0); // uid
  trailerHeaderStr += toHex8(0); // gid
  trailerHeaderStr += toHex8(1); // nlink
  trailerHeaderStr += toHex8(0); // mtime
  trailerHeaderStr += toHex8(0); // filesize
  trailerHeaderStr += toHex8(0); // maj
  trailerHeaderStr += toHex8(0); // min
  trailerHeaderStr += toHex8(0); // rmaj
  trailerHeaderStr += toHex8(0); // rmin
  trailerHeaderStr += toHex8(trailerNamesize);
  trailerHeaderStr += toHex8(0); // chksum

  chunks.push(encoder.encode(trailerHeaderStr));
  const trailerNameBuf = new Uint8Array(trailerNamesize);
  trailerNameBuf.set(trailerName, 0);
  trailerNameBuf[trailerName.length] = 0;
  chunks.push(trailerNameBuf);

  const padTrailer = (4 - ((110 + trailerNamesize) % 4)) % 4;
  if (padTrailer > 0) {
    chunks.push(new Uint8Array(padTrailer));
  }

  let currentLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const totalPad = (512 - (currentLength % 512)) % 512;
  if (totalPad > 0) {
    chunks.push(new Uint8Array(totalPad));
    currentLength += totalPad;
  }

  const result = new Uint8Array(currentLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

export const buildRpmHeader = (tags) => {
  const sortedTags = [...tags].sort((a, b) => a.tag - b.tag);

  const dataChunks = [];
  let dataOffset = 0;
  const indexEntries = [];

  for (const tagEntry of sortedTags) {
    const { tag, type, value } = tagEntry;
    let alignment = 1;
    let count = 1;
    let entryBytes;

    if (type === 3) { // INT16
      alignment = 2;
      const arr = Array.isArray(value) ? value : [value];
      count = arr.length;
      const buf = new Uint8Array(count * 2);
      const view = new DataView(buf.buffer);
      for (let i = 0; i < count; i++) {
        view.setUint16(i * 2, arr[i], false);
      }
      entryBytes = buf;
    } else if (type === 4) { // INT32
      alignment = 4;
      const arr = Array.isArray(value) ? value : [value];
      count = arr.length;
      const buf = new Uint8Array(count * 4);
      const view = new DataView(buf.buffer);
      for (let i = 0; i < count; i++) {
        view.setUint32(i * 4, arr[i], false);
      }
      entryBytes = buf;
    } else if (type === 6) { // STRING
      alignment = 1;
      count = 1;
      const strBytes = encoder.encode(String(value));
      const buf = new Uint8Array(strBytes.length + 1);
      buf.set(strBytes, 0);
      buf[strBytes.length] = 0;
      entryBytes = buf;
    } else if (type === 7) { // BIN
      alignment = 1;
      entryBytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      count = entryBytes.length;
    } else if (type === 8 || type === 9) { // STRING_ARRAY / I18NSTRING
      alignment = 1;
      const strArr = Array.isArray(value) ? value : [value];
      count = strArr.length;
      const byteChunks = [];
      let totalLen = 0;
      for (const s of strArr) {
        const sb = encoder.encode(String(s));
        const b = new Uint8Array(sb.length + 1);
        b.set(sb, 0);
        b[sb.length] = 0;
        byteChunks.push(b);
        totalLen += b.length;
      }
      const buf = new Uint8Array(totalLen);
      let off = 0;
      for (const b of byteChunks) {
        buf.set(b, off);
        off += b.length;
      }
      entryBytes = buf;
    }

    if (dataOffset % alignment !== 0) {
      const pad = alignment - (dataOffset % alignment);
      dataChunks.push(new Uint8Array(pad));
      dataOffset += pad;
    }

    indexEntries.push({
      tag,
      type,
      offset: dataOffset,
      count
    });

    dataChunks.push(entryBytes);
    dataOffset += entryBytes.length;
  }

  const dataSection = new Uint8Array(dataOffset);
  let doff = 0;
  for (const chunk of dataChunks) {
    dataSection.set(chunk, doff);
    doff += chunk.length;
  }

  const headerIntro = new Uint8Array(16);
  headerIntro[0] = 0x8e;
  headerIntro[1] = 0xad;
  headerIntro[2] = 0xe8;
  headerIntro[3] = 0x01;
  const hView = new DataView(headerIntro.buffer);
  hView.setUint32(8, indexEntries.length, false);
  hView.setUint32(12, dataSection.length, false);

  const indexBuf = new Uint8Array(indexEntries.length * 16);
  const iView = new DataView(indexBuf.buffer);
  for (let i = 0; i < indexEntries.length; i++) {
    const ie = indexEntries[i];
    iView.setUint32(i * 16, ie.tag, false);
    iView.setUint32(i * 16 + 4, ie.type, false);
    iView.setUint32(i * 16 + 8, ie.offset, false);
    iView.setUint32(i * 16 + 12, ie.count, false);
  }

  const result = new Uint8Array(16 + indexBuf.length + dataSection.length);
  result.set(headerIntro, 0);
  result.set(indexBuf, 16);
  result.set(dataSection, 16 + indexBuf.length);
  return result;
};

export async function buildRpm(electronZip, options) {
  const packageName = options.app.packageName;
  const version = options.app.version || '1.0.0';
  const arch = options.target.includes('arm64') ? 'aarch64' : 'x86_64';
  // Prefer explicit name/email fields when available for better UX; fall back to legacy maintainer string
  let maintainer = 'HyperWarp Developer <developer@hyperwarp.org>';
  if (options.linuxPackage) {
    const lp = options.linuxPackage;
    if (lp.maintainerName || lp.maintainerEmail) {
      const name = lp.maintainerName || '';
      const email = lp.maintainerEmail || '';
      maintainer = email ? `${name} <${email}>` : (name || lp.maintainer || maintainer);
    } else if (lp.maintainer) {
      maintainer = lp.maintainer;
    }
  }
  const section = (options.linuxPackage && options.linuxPackage.section) || 'games';
  const description = (options.linuxPackage && options.linuxPackage.description) || 'Packaged project using HyperWarp Packager';
  const title = options.app.windowTitle || packageName;

  const buildTime = Math.floor(Date.now() / 1000);

  // Collect files to package into CPIO archive
  const fileEntries = [
    { name: './opt', isDir: true, mode: 0o40755 },
    { name: `./opt/${packageName}`, isDir: true, mode: 0o40755 },
    { name: './usr', isDir: true, mode: 0o40755 },
    { name: './usr/bin', isDir: true, mode: 0o40755 },
    { name: './usr/share', isDir: true, mode: 0o40755 },
    { name: './usr/share/applications', isDir: true, mode: 0o40755 },
    { name: './usr/share/pixmaps', isDir: true, mode: 0o40755 }
  ];

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
    fileEntries.push({
      name: `./opt/${packageName}/${relPath}`,
      data,
      mode: isExecutable ? 0o100755 : 0o100644,
      isDir: false
    });
  }

  // Launcher script under /usr/bin/<packageName>
  const launcherScript = `#!/bin/sh\nexec /opt/${packageName}/${packageName} "$@"\n`;
  fileEntries.push({
    name: `./usr/bin/${packageName}`,
    data: encoder.encode(launcherScript),
    mode: 0o100755,
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
  fileEntries.push({
    name: `./usr/share/applications/${packageName}.desktop`,
    data: encoder.encode(desktopContent),
    mode: 0o100644,
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
  fileEntries.push({
    name: `./usr/share/pixmaps/${packageName}.png`,
    data: iconData,
    mode: 0o100644,
    isDir: false
  });

  const cpioArchive = buildCpioArchive(fileEntries);
  const payloadGzip = await gzipCompress(cpioArchive);

  // Build RPM file metadata arrays
  const dirNamesSet = new Set();
  const fileSizes = [];
  const fileModes = [];
  const fileRdevs = [];
  const fileMtimes = [];
  const fileMd5s = [];
  const fileLinkTos = [];
  const fileFlags = [];
  const fileUsernames = [];
  const fileGroupnames = [];
  const dirIndexes = [];
  const baseNames = [];

  let totalInstalledSize = 0;

  for (const item of fileEntries) {
    // Convert relative path `./opt/app/file` to full path `/opt/app/file`
    let fullPath = item.name.substring(1); // remove leading '.'
    if (item.isDir && !fullPath.endsWith('/')) {
      fullPath += '/';
    }
    const lastSlash = fullPath.lastIndexOf('/', fullPath.length - 2);
    const dirPath = fullPath.substring(0, lastSlash + 1);
    const baseName = fullPath.substring(lastSlash + 1).replace(/\/$/, '');

    dirNamesSet.add(dirPath);
  }

  const dirNames = Array.from(dirNamesSet);

  for (const item of fileEntries) {
    let fullPath = item.name.substring(1);
    if (item.isDir && !fullPath.endsWith('/')) {
      fullPath += '/';
    }
    const lastSlash = fullPath.lastIndexOf('/', fullPath.length - 2);
    const dirPath = fullPath.substring(0, lastSlash + 1);
    const baseName = fullPath.substring(lastSlash + 1).replace(/\/$/, '');

    const dirIdx = dirNames.indexOf(dirPath);
    dirIndexes.push(dirIdx);
    baseNames.push(baseName);

    const size = item.isDir ? 0 : (item.data ? item.data.length : 0);
    totalInstalledSize += size;
    fileSizes.push(size);
    fileModes.push(item.mode);
    fileRdevs.push(0);
    fileMtimes.push(buildTime);
    fileMd5s.push('');
    fileLinkTos.push('');
    fileFlags.push(0);
    fileUsernames.push('root');
    fileGroupnames.push('root');
  }

  const mainTags = [
    { tag: 1000, type: 6, value: packageName },
    { tag: 1001, type: 6, value: version },
    { tag: 1002, type: 6, value: '1' },
    { tag: 1004, type: 6, value: description },
    { tag: 1005, type: 6, value: description },
    { tag: 1006, type: 4, value: buildTime },
    { tag: 1007, type: 6, value: 'hyperwarp' },
    { tag: 1009, type: 4, value: totalInstalledSize },
    { tag: 1014, type: 6, value: 'Proprietary' },
    { tag: 1015, type: 6, value: maintainer },
    { tag: 1016, type: 6, value: section },
    { tag: 1021, type: 6, value: 'linux' },
    { tag: 1022, type: 6, value: arch },
    { tag: 1027, type: 6, value: 'cpio' },
    { tag: 1028, type: 6, value: 'gzip' },
    { tag: 1029, type: 6, value: '9' },
    { tag: 1035, type: 4, value: fileSizes },
    { tag: 1037, type: 3, value: fileModes },
    { tag: 1040, type: 3, value: fileRdevs },
    { tag: 1041, type: 4, value: fileMtimes },
    { tag: 1042, type: 8, value: fileMd5s },
    { tag: 1043, type: 8, value: fileLinkTos },
    { tag: 1044, type: 4, value: fileFlags },
    { tag: 1045, type: 8, value: fileUsernames },
    { tag: 1046, type: 8, value: fileGroupnames },
    { tag: 1047, type: 8, value: [packageName] },
    { tag: 1048, type: 4, value: [0] },
    { tag: 1049, type: 8, value: ['/bin/sh'] },
    { tag: 1050, type: 8, value: [''] },
    { tag: 1094, type: 4, value: dirIndexes },
    { tag: 1112, type: 8, value: [`0:${version}-1`] },
    { tag: 1113, type: 4, value: [8] },
    { tag: 1116, type: 8, value: baseNames },
    { tag: 1117, type: 8, value: dirNames }
  ];

  // Build main header and ensure 8-byte alignment (required by RPM spec)
  const _mainHeader = buildRpmHeader(mainTags);
  let mainHeader = _mainHeader;
  if (mainHeader.length % 8 !== 0) {
    const pad = 8 - (mainHeader.length % 8);
    const paddedMain = new Uint8Array(mainHeader.length + pad);
    paddedMain.set(mainHeader, 0);
    mainHeader = paddedMain;
  }

  // Create an empty signature header (zero tags) — RPM expects a signature header area even for unsigned packages
  let sigHeader = buildRpmHeader([]);
  if (sigHeader.length % 8 !== 0) {
    const pad = 8 - (sigHeader.length % 8);
    const paddedSig = new Uint8Array(sigHeader.length + pad);
    paddedSig.set(sigHeader, 0);
    sigHeader = paddedSig;
  }

  // Lead (96 bytes)
  const lead = new Uint8Array(96);
  lead[0] = 0xed; lead[1] = 0xab; lead[2] = 0xee; lead[3] = 0xdb;
  lead[4] = 3; lead[5] = 0;
  const lView = new DataView(lead.buffer);
  lView.setUint16(6, 1, false); // Binary type
  lView.setUint16(8, arch === 'aarch64' ? 18 : 1, false);
  const nameBytes = encoder.encode(packageName).subarray(0, 65);
  lead.set(nameBytes, 10);
  lView.setUint16(76, 1, false); // Linux OS
  lView.setUint16(78, 5, false); // Header standalone signature (0x5 indicates header present)

  const totalRpmLen = lead.length + sigHeader.length + mainHeader.length + payloadGzip.length;
  const rpmBuffer = new Uint8Array(totalRpmLen);
  let offset = 0;

  rpmBuffer.set(lead, offset);
  offset += lead.length;

  rpmBuffer.set(sigHeader, offset);
  offset += sigHeader.length;

  rpmBuffer.set(mainHeader, offset);
  offset += mainHeader.length;

  rpmBuffer.set(payloadGzip, offset);

  return rpmBuffer;
}
