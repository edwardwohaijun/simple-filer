module.exports = Filer;

const msgPayloadSize = 64 * 1024 - 48; // msgSize: 64k, dataType: 8 bytes, chunkIdx: 8 bytes, msgIdx: 8 bytes, padding: 8 bytes, fileID: 16bytes
const chunkSize = msgPayloadSize * 32;  // each chunk need to send 32 msgs. This is also the memStore size to store the current chunk

var Peer = require('simple-peer');
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

    var makeBufferReq = new ArrayBuffer(32);
    new Float64Array(makeBufferReq, 0, 1)[0] = 2; // dataType
    new Float64Array(makeBufferReq, 8, 1)[0] = evt.target.result.byteLength; // bufferSize to be allocated
    var fileIdBuf = new Uint16Array(makeBufferReq, 16, 8); // fileID(8 character, 16 bytes)
    for(let i=0; i<fileIdBuf.length; i++){
      fileIdBuf[i] = fileID.charCodeAt(i)
    }
    p.send(makeBufferReq); // ask receiver to allocate the specified buffer for incoming chunk data

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
//Filer.prototype._saveChunk = function({fileID, chunkIdx, msgIdx, peerID, data}) {
  var chunk = parseFileChunk(data.data);
  var receivingBuffer = this.peers[data.peerID].files.receiving[chunk.fileID]; // memStore.set( new Uint8Array(data.buffer), byte64kOffset); byte64kOffset += chunkSize;
  receivingBuffer.set(new Uint8Array(chunk.data), msgPayloadSize * chunk.msgIdx);
  if (chunk.msgIdx + 1 == Math.ceil(receivingBuffer.byteLength / msgPayloadSize)){
    console.log('last msg in current chunk, generate url');
    var fileStat = this._getFileStat(chunk.fileID);
    var blob = new Blob([this.peers[data.peerID].files.receiving[chunk.fileID]], {type: fileStat.fileType});
    var url = window.URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileStat.fileName;
    document.body.appendChild(a);
  }
};

Filer.prototype._parseData = function(data){
  var dataType = new Float64Array(data.data.buffer, 0, 1)[0]; // 凡是data channel过来的数据, 需要parse, 一律读取该数据的 data.buffer
  switch (dataType){
    case 0: // fileMeta: filename, size, id, type
      var fileInfo = parseFileMeta(data.data);
      this.tasks.push({
        fileID: fileInfo.id, fileName: fileInfo.name.substr(0, fileInfo.nameLength),
        fileSize: fileInfo.size, fileType: fileInfo.type.substr(0, fileInfo.typeLength),
        from: data.peerID, to: this.myID
      }); // push to tasks, trigger an event, let client to add it on the page.
      this.peers[data.peerID].peerObj.send( makeFileChunkReq({chunkIdx: 0, id: fileInfo.id}) ); // send the chunk req for the 1st chunk
      break;
    case 1: // fileChunkReq, receiver send the chunk requested(read from disk into memStore first)
      var chunkInfo = parseFileChunkReq(data.data);
      console.log('before calling _sendChunk, chunkInfo: ', chunkInfo);
      this._sendChunk({fileID: chunkInfo.id, chunkIdx: chunkInfo.chunkIdx, peerID: data.peerID});
      break;
    case 2: // makeBufferReq, receiver make a buffer(of specified size) for the incoming chunk data
      var bufferSizeInfo = parseMakeBufferSizeReq(data);
      this.peers[data.peerID].files.receiving[ bufferSizeInfo.fileID ] = new Uint8Array( bufferSizeInfo.bufferSize );
      break;
    case 3: // fileChunk data, receiver save it into file buffer, actually it's one piece of the fileChunk
      console.log('fileChunk data coming, save it into file Buffer');
      this._saveChunk(data);
      break;
    default:
      console.log('Oops, unknown data type: ', dataType)
  }
};

// 而且是否会发生: sender发送metaFile, 同时receiver发送 data fetch req, 同一个file只需一方发送即可???
// credit: https://stackoverflow.com/questions/10726909/random-alpha-numeric-string-in-javascript
function randomString(length, chars) {
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


