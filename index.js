//var u = require('FileSystemAPI');
//import {fs, fileExists, getFile, getFileWriter, removeFile} from './FileSystemAPI';
const Peer = require('simple-peer');
const msgPayloadSize = 64 * 1024 - 48; // msgSize: 64k, dataType: 8 bytes, chunkIdx: 8 bytes, msgIdx: 8 bytes, padding: 8 bytes, fileID: 16bytes
const chunkSize = msgPayloadSize * 32;  // each chunk need to send 32 msgs. This is also the memStore size to store the current chunk
//const msgCount = 32;  // chunkSize / msgPayloadSize; the max msgCount in a chunk

module.exports = Filer;

function Filer({myID, ws}){
  this.signalingChannel = ws || null;
  this.myID = myID || '';
}
Filer.prototype.peers = {};
Filer.prototype.tasks = []; // used to show sending/receiving progress on page.

Filer.prototype._createPeerConnection = function (offerUID, answerUID, initiator, signalingChannel) { // todo 用obj作为参数，而非多个individual arguments
  var peerID = initiator ? answerUID : offerUID;
  if (this.peers[peerID]){ // this.peers[peerID] is an obj who has 2 keys: peerObj and files
    this.peers[peerID].peerObj = new Peer({initiator: initiator, trickle: true}); // peerObj is created by  _createPeerConnection(), files is created by _send() function
  } else { // 既然我调用 createConnection 则说明 this.peers[peerID] 肯定不存在, 否则要调用做啥呢?????? 怎么会需要if/else呢
    this.peers[peerID] = {peerObj: new Peer({initiator: initiator, trickle: true})}
  }

  if (!this.peers[peerID].files){
    this.peers[peerID].files = {sending: {}, receiving:{}}
  }

  var p = this.peers[peerID].peerObj;
  p._peerID = peerID; // don't want to mess with channelName

  p.on('signal', function (signalingData) {
    if (p.initiator) {
      signalingChannel.send(JSON.stringify({msgType: 'signaling', from: offerUID, to: answerUID, signalingData: signalingData}))
    } else {
      signalingChannel.send(JSON.stringify({msgType: 'signaling', from: answerUID, to: offerUID, signalingData: signalingData}))
    }
  });

  p.on('connect', function(){
    this._runTask()
  }.bind(this));

  p.on('data', function(data){
    this._parseData({data: data, peerID: p._peerID});
  }.bind(this));

  p.on('close', function(){ // close and error: need to destroy all memStore associated with this broken peer
    console.log('peer is closed')
  });

  p.on('error', function(err){
    console.log('peer error: ', err)
  });

  return p
};

Filer.prototype.handleSignaling = function(data){
  var p;
  this.peers[data.from] && (p = this.peers[data.from].peerObj);

  if (!p){ // I'm answerer(initiator == false), possible race condition: A and B try to establish connection to other side at the same time
    p = this._createPeerConnection(data.from, this.myID, false, this.signalingChannel);
  }
  p.signal(data.signalingData);
};

Filer.prototype.send = function(toWhom, fileObj){
  if (!fileObj) throw Error("no file selected");
  if (!toWhom) throw Error("no peer selected");
  var fileID = randomString(); // todo: I need a taskID(random string)
  this.tasks.push(
      {
        fileID: fileID, fileName: fileObj.name, fileSize: fileObj.size, fileType: fileObj.type,
        from: this.myID, to: toWhom, status: 'pending'
      }
  ); // status: running/pending/done

  if (!this.peers[toWhom]){
    this.peers[toWhom] = {files: {sending: {[fileID]: fileObj}}, receiving:{}}; // for sending: {fileID: fileObj}, for receiving: {fileID: arrayBuffer}
  } else { // todo: 第二次点击 send 岂不是会把之前的 files 覆盖???????
    this.peers[toWhom].files.sending[fileID] = fileObj; // 这样就不覆盖了
    this.peers[toWhom].files.receiving = {}
  }

  var p = this.peers[toWhom].peerObj;
  if (p && p.connected){
    this._runTask();
  } else if (p){ // peer exists, but not connected, still connecting
    console.log('p exist, but not ready, just wait'); // doNothing, just wait
  } else { // peer doesn't exist yet, need to create
    console.log('p doesnt exist, create it now');
    this._createPeerConnection(this.myID, toWhom, true, this.signalingChannel);
  }
};

Filer.prototype._runTask = function(){
  var t;
  for(let i = 0; i < this.tasks.length; i++) {
    if (this.tasks[i].status == 'pending') {
      this.tasks[i].status = 'running';
      t = this.tasks[i];
      break
    }
  }
  if (t) {
    if (t.from == this.myID) { // I'm the file sender
      //this.peers[fileInfo.to].files.sending[t.fileID]
      var fileInfo = {id: t.fileID, size: t.fileSize, name: t.fileName, type: t.fileType, to: t.to};
      this.peers[fileInfo.to].peerObj.send( makeFileMeta(fileInfo) )
    } else if (t.to == this.myID){ // I'm the file receiver
      //this.peers[t.from].send("the file I want is: " + t.file.name + ' fileID: ' + t.file.id);
      console.log('receiving file now'); // do nothing, wait for fileMeta
    } else {
      console.log('Oops')
    }
  }
};

////////////////////////////////////////////
//---------- data protocol -----------------
// first byte is data type: 0(fileMeta), receiver need to save this info(fileID/Name/Size) in his/her tasks, then send back the fileChunkReq
//                          1(fileChunkReq), receiver send the fileChunkReq(what chunk of which file that I need)
//                          2(fileChunk), after receiving receiver's fileChunkReq, sender grab the chunk from the file, then send it out(need forloop to finish the whole chunk)


function makeFileMeta(fileInfo){
  console.log('fileinfo: ', fileInfo);
  // |dataType = 0(8bytes) | fileSize(8bytes) | fileID(8 chars, 16bytes) | fileNameLength(8 bytes) | 8 bytes padding | fileName | fileTypeLength(8bytes) | 8 byte padding | fileType(mime type |
  var buf = new ArrayBuffer( 8 + 8 + 16 + 8 + 8 + 128 + 8 + 8 + 128);
  new Float64Array(buf, 0, 1)[0] = 0; // dataType(8 bytes) = 0
  new Float64Array(buf, 8, 1)[0] = fileInfo.size; // fileSize(8 bytes)

  var fileID = new Uint16Array(buf,16, 8); // fileID(8 character, 16 bytes)
  for(let i=0; i<fileID.length; i++){
    fileID[i] = fileInfo.id.charCodeAt(i)
  }

  new Float64Array(buf, 32, 1)[0] = fileInfo.name.length ;

  var fileName = new Uint16Array(buf, 48, 64);
  for(let i=0; i<fileName.length; i++){
    if (i == fileInfo.name.length) break;
    fileName[i] = fileInfo.name.charCodeAt(i)
  }

  new Float64Array(buf, 176, 1)[0] = fileInfo.type.length;

  var fileType = new Uint16Array(buf, 192);
  for(let i = 0; i<fileType.length; i++){
    if (i == fileInfo.type.length) break;
    fileType[i] = fileInfo.type.charCodeAt(i)
  }

  return buf;
}

function parseFileMeta(data){
  var fileInfo = {};
  fileInfo.size = new Float64Array(data.buffer, 8, 1)[0];
  fileInfo.id = String.fromCharCode.apply(null, new Uint16Array(data.buffer, 16, 8));

  fileInfo.nameLength = new Float64Array(data.buffer, 32, 1)[0];
  fileInfo.name = String.fromCharCode.apply(null, new Uint16Array(data.buffer, 48, 64));

  fileInfo.typeLength = new Float64Array(data.buffer, 176, 1)[0];
  fileInfo.type = String.fromCharCode.apply(null, new Uint16Array(data.buffer, 192));

  console.log('after parsing fileMeta: ', fileInfo);
  return fileInfo;
}

function makeFileChunkReq(chunkInfo){ // |dataType = 1(8 bytes)|chunkIndex(8 bytes)|fileID(16bytes)|
  console.log('chunkInfo before make it: ', chunkInfo);
  var buf = new ArrayBuffer(8 + 8 + 16);
  new Float64Array(buf, 0, 1)[0] = 1; // dataType = 1
  new Float64Array(buf, 8, 1)[0] = chunkInfo.chunkIdx; // chunkIdx

  var fileID = new Uint16Array(buf,16, 8); // fileID(8 character, 16 bytes)
  for(let i=0; i<fileID.length; i++){
    fileID[i] = chunkInfo.id.charCodeAt(i)
  }
  return buf;
}

function parseFileChunkReq(data){
  var chunkInfo = {};
  chunkInfo.chunkIdx = new Float64Array(data.buffer, 8, 1)[0];
  chunkInfo.id = String.fromCharCode.apply(null, new Uint16Array(data.buffer, 16, 8));
  console.log('chunkInfo after parsing: ', chunkInfo);
  return chunkInfo;
}

// actually, it's the msg of the whole chunk
function makeFileChunk(chunkData){ // |dataType = 3(8 bytes)|chunkIdx(8 bytes)|
  var buf = new ArrayBuffer(64 * 1024); // fully utilise max allowed msg size
  new Float64Array(buf, 0, 1)[0] = 3; // dataType = 3
  new Float64Array(buf, 8, 1)[0] = chunkData.chunkIdx; // chunkIdx

  var fileID = new Uint16Array(buf,16, 8); // fileID(8 character, 16 bytes)
  for(let i=0; i<fileID.length; i++){
    fileID[i] = chunkData.fileID.charCodeAt(i)
  }
  new Uint8Array(buf, 8 + 8 + 16)
}

function parseFileChunk(data){
  var chunk = {};
  chunk.chunkIdx = new Float64Array(data.buffer, 8, 1)[0];
  chunk.fileID = String.fromCharCode.apply(null, new Uint16Array(data.buffer, 32, 8));
  chunk.msgIdx = new Float64Array(data.buffer, 16, 1)[0];
  chunk.data = new Uint8Array(data.buffer, 48);
  console.log('after parsing fileChunkMeta: ', chunk);
  return chunk;
}

function parseMakeBufferSizeReq(data){
  var makeBufferReq = {};
  makeBufferReq.bufferSize = new Float64Array(data.data.buffer, 8, 1)[0];
  makeBufferReq.fileID = String.fromCharCode.apply(null, new Uint16Array(data.data.buffer, 16, 8));
  return makeBufferReq;
}

Filer.prototype._sendChunk = function({fileID, chunkIdx, peerID}){
  const fileObj = this.peers[peerID].files.sending[fileID];
  console.log('fileOBJ: ', this.peers[peerID].files);
  console.log('sending chunk: fileID/chunkIdx/peerID/fileObj', fileID, '/', chunkIdx, '/', peerID, '/', fileObj);

  var dataTypeBuf = new Float64Array(1);
  dataTypeBuf[0] = 2;

  var chunkIdxBuf = new Float64Array(1);
  chunkIdxBuf[0] = chunkIdx;

  var p = this.peers[peerID].peerObj;
  var slice = fileObj.slice(chunkSize * chunkIdx , chunkSize * (1 + chunkIdx)); // slice(startingByte, endingByte)
  var reader = new window.FileReader();
  reader.readAsArrayBuffer(slice);
  reader.onload = function(evt) {
    var bufferSizeBuf = new Float64Array(1);
    bufferSizeBuf[0] = evt.target.result.byteLength;


    //var makeBufferReq = new ArrayBuffer(32);
    //new Float64Array(makeBufferReq, 0, 1)[0] = 2; // dataType
    //new Float64Array(makeBufferReq, 8, 1)[0] = evt.target.result.byteLength; // bufferSize to be allocated
    //var fileIdBuf = new Uint16Array(makeBufferReq, 16, 8); // fileID(8 character, 16 bytes)
    //for(let i=0; i<fileIdBuf.length; i++){
      //fileIdBuf[i] = fileID.charCodeAt(i)
    //}
    //p.send(makeBufferReq); // ask receiver to allocate the specified buffer for incoming chunk data

    var fileChunkMeta = new ArrayBuffer(48);
    new Float64Array(fileChunkMeta, 0, 1)[0] = 3; // dataType
    new Float64Array(fileChunkMeta, 8, 1)[0] = chunkIdx;
    fileIdBuf = new Uint16Array(fileChunkMeta, 32, 8); // fileID(8 character, 16 bytes)
    for(let i=0; i<fileIdBuf.length; i++){
      fileIdBuf[i] = fileID.charCodeAt(i)
    }

    var memStore = new Uint8Array(evt.target.result);
    const msgCount = Math.ceil( memStore.byteLength / msgPayloadSize );
    var msg, data;
    for (var i=0; i<msgCount; i++){
      new Float64Array(fileChunkMeta, 16, 1)[0] = i;
      data = memStore.slice(i * msgPayloadSize, (i+1) * msgPayloadSize);
      console.log('data: ', data);
      msg = new Uint8Array(48 + data.byteLength);
      console.log('fileChunkMeta: ', fileChunkMeta);
      msg.set(new Uint8Array(fileChunkMeta));
      msg.set(data, 48);
      console.log('msg to be sent: ', msg);
      p.send(msg);
    }
  };
};

Filer.prototype._getFileStat = function(fileID){
  var fileStat = {};
  for(let i = 0; i< this.tasks.length; i++){
    if (this.tasks[i].fileID == fileID){
      fileStat = this.tasks[i];
      break;
    }
  }
  return fileStat
};

Filer.prototype._saveChunk = function(data) {
  var chunk = parseFileChunk(data.data);
  var receivingBuffer = this.peers[data.peerID].files.receiving[chunk.fileID];
  if (!receivingBuffer){
    receivingBuffer = this.peers[data.peerID].files.receiving[chunk.fileID] = new Uint8Array( chunkSize )
  }
  receivingBuffer.set(new Uint8Array(chunk.data), msgPayloadSize * chunk.msgIdx);

  var fileStat = this._getFileStat(chunk.fileID);

  console.log('incoming chunk data: ', chunk.data);
  const maxMsgCount = chunkSize / msgPayloadSize;
  if (chunk.msgIdx + 1 == maxMsgCount
      || chunk.msgIdx + chunk.chunkIdx * maxMsgCount == Math.floor(fileStat.fileSize / msgPayloadSize) ){

    var isLastChunk = chunk.chunkIdx + 1 == Math.ceil(fileStat.fileSize / chunkSize ); // last chunk in current file?
    console.log('last msg in current chunk, but is last chunk? ', isLastChunk);
    if (isLastChunk){ // each chunkSize is "msgPayloadSize * 32", but the last chunk is probably less than that, I need to grab the exact size
      writeFile(this.peers[data.peerID].peerObj, receivingBuffer.slice(0, chunk.msgIdx * msgPayloadSize + chunk.data.length), chunk.chunkIdx, fileStat, isLastChunk);
    } else {
      writeFile(this.peers[data.peerID].peerObj, receivingBuffer, chunk.chunkIdx, fileStat, isLastChunk);
    }
  }
};

Filer.prototype._parseData = function(data){
  var dataType = new Float64Array(data.data.buffer, 0, 1)[0]; // 凡是data channel过来的数据, 需要parse, 一律读取该数据的 data.buffer
  switch (dataType){
    case 0: // fileMeta: filename, size, id, type
      var fileInfo = parseFileMeta(data.data);
      if (!this.peers[data.peerID].files.receiving[ fileInfo.id ]){
        this.peers[data.peerID].files.receiving[ fileInfo.id ] = new Uint8Array( chunkSize ); // create buffer for incoming file chunk data
      }

      this.tasks.push({
        fileID: fileInfo.id, fileName: fileInfo.name.substr(0, fileInfo.nameLength),
        fileSize: fileInfo.size, fileType: fileInfo.type.substr(0, fileInfo.typeLength),
        from: data.peerID, to: this.myID
      }); // todo: push to tasks, trigger an event, let client to add it on the page.
      this.peers[data.peerID].peerObj.send( makeFileChunkReq({chunkIdx: 0, id: fileInfo.id}) ); // send the chunk req for the 1st chunk
      break;
    case 1: // fileChunkReq, receiver send the chunk requested(read from disk into memStore first)
      var chunkInfo = parseFileChunkReq(data.data);
      console.log('before calling _sendChunk, chunkInfo: ', chunkInfo);
      this._sendChunk({fileID: chunkInfo.id, chunkIdx: chunkInfo.chunkIdx, peerID: data.peerID});
      break;
    case 2: // makeBufferReq, receiver make a buffer(of specified size) for the incoming chunk data
      var bufferSizeInfo = parseMakeBufferSizeReq(data);
      var currentBuffer = this.peers[data.peerID].files.receiving[ bufferSizeInfo.fileID ];
      if (!currentBuffer || currentBuffer.byteLength != bufferSizeInfo.bufferSize){
        this.peers[data.peerID].files.receiving[ bufferSizeInfo.fileID ] = new Uint8Array( bufferSizeInfo.bufferSize );
      } // if buffer doesn't exist OR exist but its byteLength not equal to the new buffer size, create it
      // only the last chunk's bufferSize might not equal to current buffer size
      break;
    case 3: // fileChunk data, receiver save it into file buffer, actually it's one piece of the fileChunk
      console.log('fileChunk data coming, save it into file Buffer');
      this._saveChunk(data);
      break;
    default:
      console.log('Oops, unknown data type: ', dataType)
  }
};

const writeFile = (peer, data, chunkIdx, fileObj, isLastChunk) => {
  if (fileObj.fileWriter) { // todo, when the whole file is done receiving, remove this fileWriter on fileObj(in tasks)
    console.log('fileWriter exist');
    doWriting(fileObj.fileWriter, fileObj, peer, chunkIdx, data, isLastChunk);
    // 此时FS中可能已经有部分data写入了, 必须transfer view是提示用户, 该文件传输错误, 需要删除, 只有执行了删除, 才把整个 fileObj 删除(它也是挂在另外一个obj上的).
  } else { // 如何告知sender, snackbar显示, 同时transfer view上也要显示.
    console.log('fileWriter not exist');
    fs(fileObj).then(fileExists).then(getFile).then(getFileWriter).then(writer => { // 如果同名文件已经在FS中存在, 则: getFile 会在文件名后生成一个random str 供后面的 getFileWriter 写入之用.
      doWriting(writer, fileObj, peer, chunkIdx, data, isLastChunk);
    }, err => { // any error or reject in the upstream promise chain would be handled in this block.
      //console.log('error in promise chain: ', err); // 还要socket告知对方, snackbarHandler告知本人. fileObj是否需要一个 .err property, 在transfer View上显示???
      fileObj.fileWriter = null; // 尤其这个fileWriter, 不reset to null, the next file writer would use this one.
    }); // todo: fileWriter 当整个文件全部写完, 还是需要set to null
  }
};

const doWriting = (writer, fileObj, peer, chunkIdx, data, isLastChunk) => {
  //console.log('inside doWriting, fileObj: ', fileObj);
  writer.seek( chunkIdx * chunkSize);
  writer.onerror = e => {console.log('Write failed: ' + e.toString()); }; // 需要一个独立的Writer err handler, 任何地方, 包含promise chain出错, 调用该err handler, 其内:
  writer.write(new Blob([data], {type: fileObj.fileType}));  // err handler中需要snakcbar, peer, 通过peer发送给对方msg, 告知: 放弃写入, 因为我这里出错了. // reset fileObj.....
  writer.onwriteend = e => {
    //fileObj.progress = Math.ceil( ((chunkIdx * chunkSize + data.byteLength) / fileObj.fileSize)*100 );
    console.log('done writing');
    //       this.peers[data.peerID].peerObj.send( makeFileChunkReq({chunkIdx: 0, id: fileInfo.id}) ); // send the chunk req for the 1st chunk
    if (!isLastChunk){
      peer.send(makeFileChunkReq({chunkIdx: chunkIdx + 1, id: fileObj.fileID}));
    }
    //peer.send('ta da'); // 一个block写完, 发一条msg给发送方, 你可以发下个block的数据了.
  }; // 即使写入失败, onwriteend也会触发, 但此刻seek value就不对了, 繁啊.
};

// filesystem API
window.requestFileSystem = window.requestFileSystem || window.webkitRequestFileSystem;
// https://www.toptal.com/javascript/javascript-promises
const fs = fileObj => { // 我感觉还需要传输 snackbarHandler, socket, 便于: 出错时候, 告知本人, 对方. 出错后, fileObj的诸多property都要设为null.
  return new Promise(function (resolve, reject) {
    window.requestFileSystem(window.TEMPORARY, 4*1024*1024*1024,
        ({root}) => {
          resolve({root:root, fileObj: fileObj})
        },
        reject);
  });
};

const fileExists = ({root, fileObj}) => {
  return new Promise(function(resolve, reject) {
    root.getFile(fileObj.fileName, {create: false}, // 并非真的要获取fileEntry, 而是判断是否该文件存在, 故: 必须用: create: false
            fileEntry => { // 创建文件是在下一步: getFile中, 在那里, 有: create: true
              var filename = fileObj.fileName.substring(0, fileObj.fileName.lastIndexOf('.'));
              var ext = fileObj.fileName.substring(fileObj.fileName.lastIndexOf('.'));
              var randomStr = randomString(); // 待写入的文件名有重复, 则: 文件名后加 _randomStr + file extension
              fileObj.fileName = filename + '_' + randomStr + ext;
              resolve({root:root, fileObj: fileObj});
            },
            err => { // 本promise的目的就在于: 判断待写入文件是否存在, 如果存在, 说明待写入文件需要换个文件名, 上面的handler中已经做此处理了.
              // 如果文件名不存在, 则: 可以直接写入, 此时对于我的case而言, 这个不算是err, 故: 还是执行resolve()
              //console.log(err.name); // chrome 54 用的err.name是 NotFoundError. 之前的版本用的是: NOT_FOUND_ERR,
              if (err.name === 'NOT_FOUND_ERR' || err.name === 'NotFoundError'){ // 但可能执行getFile的时候出其他类型的错, 即: 非 NOT_FOUND_ERR, 此时才是真正的错, 执行reject, 让整个chain最后的err handler去处理.
                resolve({root:root, fileObj: fileObj});
              } else reject(err)
            }
    );
  })
};

const getFile = ({root, fileObj}) => {
  return new Promise(function(resolve, reject){
    root.getFile(fileObj.fileName, {create:true}, fileEntry => {
      resolve({fileEntry: fileEntry, fileObj: fileObj});
    }, err => reject(err))
  })
};

const getFileWriter = ({fileEntry, fileObj}) => {
  return new Promise(function(resolve, reject){
    fileEntry.createWriter(fileWriter => {
      fileObj.fileWriter = fileWriter;
      resolve(fileWriter)
  }, err => reject(err))
  })
};

const removeFile =  ({fileEntry}) => { // 必须 fs(fileObj).then(getFile).then(removeFile), 这样调用.
  return new Promise(function(resolve, reject){
    fileEntry.remove(()=>{
      resolve('success')
    }, err => reject(err))
  })
};

// 而且是否会发生: sender发送metaFile, 同时receiver发送 data fetch req, 同一个file只需一方发送即可???
// credit: https://stackoverflow.com/questions/10726909/random-alpha-numeric-string-in-javascript
function randomString(length, chars) { // todo: FileSystemAPI 中也有用到, factor out
  length = length || 8;
  chars = chars || '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var result = '';
  for (var i = length; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

function ab2str(buf) {
  return String.fromCharCode.apply(null, new Uint16Array(buf));
}

function str2ab(str) {
  var buf = new ArrayBuffer(str.length*2); // 2 bytes for each char
  var bufView = new Uint16Array(buf);
  for (var i=0, strLen=str.length; i<strLen; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}
