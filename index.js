const Peer = require('simple-peer');
const msgPayloadSize = 64 * 1024 - 48; // msgSize: 64k, dataType: 8 bytes, chunkIdx: 8 bytes, msgIdx: 8 bytes, padding: 8 bytes, fileID: 16bytes(8 characters)
const chunkSize = msgPayloadSize * 32;  // each chunk need to send 32 msg in a loop. This is also the memStore/buffer size to store the current chunk

module.exports = Filer;

function Filer({myID, ws}){ // need more arguments: iceServer
  this.signalingChannel = ws || null;
  this.myID = myID || '';
}

Filer.prototype = new EventEmitter();
//Filer.prototype = Object.create(EventEmitter.prototype); // this is not gonna work, because the EM's this.events obj is not initialised, you must use an instance of EM.
Filer.prototype.constructor = Filer;

Filer.prototype.peers = {};
Filer.prototype.tasks = [];

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

  p.on('close', function(){ // todo: close and error evt: need to destroy all memStore associated with this broken peer
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

  if (!p){ // I'm answerer(initiator == false), potential race condition: A and B try to establish connection to other side at the same time
    p = this._createPeerConnection(data.from, this.myID, false, this.signalingChannel);
  }
  p.signal(data.signalingData);
};

Filer.prototype.send = function(toWhom, fileObj){
  if (!fileObj) throw Error("no file selected");
  if (!toWhom) throw Error("no peer selected");
  var fileID = randomString();
  var newTask = {
    fileID: fileID, fileName: fileObj.name, fileSize: fileObj.size, fileType: fileObj.type,
    progress: 0, from: this.myID, to: toWhom, status: 'pending'
  };
  this.tasks.push(newTask);
  // status: pending/sending/receiving/done/removed.

  this.emit('newTask', newTask);

  if (!this.peers[toWhom]){
    this.peers[toWhom] = {files: {sending: {[fileID]: fileObj}, receiving:{}}}; // for sending: {fileID: fileObj}, for receiving: {fileID: arrayBuffer}
  } else {
    this.peers[toWhom].files.sending[fileID] = fileObj;
    if (!this.peers[toWhom].files.receiving){ // is this redundant ?
      this.peers[toWhom].files.receiving = {};
    }
  }

  var p = this.peers[toWhom].peerObj;
  if (p && p.connected){
    this._runTask();
  } else if (p){
    console.log('p exist, but not ready, just wait');
  } else {
    console.log('p does not exist, create it now');
    this._createPeerConnection(this.myID, toWhom, true, this.signalingChannel);
  }
};

Filer.prototype.removeTask = function(fileID){
// todo: peer's close/error evt handler must call removeTask
// removeTask() is called either by user clicking the 'remove' button, or receiving the 'removeReq' peer msg
// 2 pieces of data need to be removed for file sender: item in tasks array, object on this.peers.peerID.files.sending.fileID
// 3 pieces of data need to be removed for file receiver: ...................array buffer on ..................receiving.fileID, and written chunk in chrome FIleSystem

  // 文件名有空格, 特殊字符咋办? they are part of the url now?????
  var fileStat = this._getFileStat(fileID);
  if (!fileStat){return}

  var fileToBeRemoved, peer;
  var peerList = Object.keys(this.peers);
  for (let i = 0; i< peerList.length; i++){
    fileToBeRemoved = this.peers[ peerList[i] ].files.sending[fileID] || this.peers[ peerList[i] ].files.receiving[fileID];
    if (fileToBeRemoved) {
      if (fileToBeRemoved instanceof Uint8Array){ // delete the file in chrome FS
      // this is an unsafe operation, it's possible that data is being written at the same time it's being removed, thus cause the following error:
      // Uncaught (in promise) DOMException: It was determined that certain files are unsafe for access within a Web application, or that too many calls are being made on file resources.
        fs({fileName: fileStat.fileName}).then(getFile).then(removeFile)
      }
      delete this.peers[ peerList[i]].files.sending[fileID]; // just one of them exist, but it doesn't hurt to delete a non-exist object
      delete this.peers[ peerList[i]].files.receiving[fileID];
      peer = this.peers[ peerList[i]].peerObj;

      if (peer && peer.connected){
        peer.send(makeRemoveReq(fileID));
      }
      break
    }
  }

  this._updateStatus({fileID: fileID, status: 'removed'}); // must call this before the following tasks.splice, otherwise, the task is gone

  var taskIdx = this.tasks.indexOf(fileStat);
  if (taskIdx != -1){ // redundant
    this.tasks.splice(taskIdx, 1);
  }
  console.log('after removing task, now task is: ', this.tasks);
};

Filer.prototype._runTask = function(){
  var t;
  for(let i = 0; i < this.tasks.length; i++) {
    if (this.tasks[i].status == 'pending') { // _runTask only run when p2p connection is established, thus when status is always pending, it means p2p connection failed
      //this.tasks[i].status = 'running'; // the 'pending' status is soon to be updated by _sendChunk, _saveChunk
      t = this.tasks[i];
      break
    }
  }
  if (t) {
    if (t.from == this.myID) { // I'm the file sender
      var fileInfo = {id: t.fileID, size: t.fileSize, name: t.fileName, type: t.fileType, to: t.to};
      this.peers[fileInfo.to].peerObj.send( makeFileMeta(fileInfo) )
    } else if (t.to == this.myID){ // I'm the file receiver
      console.log('receiving file now, wait for fileMeta');
    } else {
      console.log('Oops, not supposed to happen')
    }
  }
};

//---------- data protocol -----------------
// first 8 bytes is data type, just an integer from 0 to 4, 1 byte is enough, but for the padding purpose
// 0(fileMeta), file sender send this msg to file receiver, ask it to save this info(fileID/Name/Size/Type/...) in tasks obj, create the buffer to hold the incoming chunk, then send back the fileChunkReq
// 1(fileChunkReq), msg receiver(file sender) parse this msg, extract the fileID/chunkIdx, then read the data from file object, send the chunk(in a for loop) to file receiver
// 2(removeReq), msg receiver parse this msg, extract the fileID, do some cleanup for the specified file
// 3(fileChunk), file receiver parse this msg, save the msg data in corresponding buffer, if this is the last msg in a chunk, save the whole chunk in chrome FileSystem
// 4(receivedNotice), file receiver send this msg to file sender, notifying that the file has been successfully saved in chrome fileSystem
// fileID consumes 16bytes(8 random characters), fileIdx consumes 8bytes(just an integer),

function makeFileMeta(fileInfo){
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

  return fileInfo;
}

function makeFileChunkReq(chunkInfo){ // |dataType = 1(8 bytes)|chunkIndex(8 bytes)|fileID(16bytes)|
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
  return chunkInfo;
}

function makeRemoveReq(fileID){ // ask receiver/sender to stop receiving/sending the next chunk and cancel the whole transfer operation
  var buf = new ArrayBuffer(32);
  new Float64Array(buf, 0, 1)[0] = 2; // dataType = 2
  var fileIDbuf = new Uint16Array(buf,16, 8);
  for(let i=0; i<fileIDbuf.length; i++){
    fileIDbuf[i] = fileID.charCodeAt(i)
  }
  return buf;
}

function parseRemoveReq(data){
  return String.fromCharCode.apply(null, new Uint16Array(data.buffer, 16, 8));
}

// makeFileChunk() function is built into _sendChunk(), its dataType is 3
function parseFileChunk(data){
  var chunk = {};
  chunk.chunkIdx = new Float64Array(data.buffer, 8, 1)[0];
  chunk.fileID = String.fromCharCode.apply(null, new Uint16Array(data.buffer, 32, 8));
  chunk.msgIdx = new Float64Array(data.buffer, 16, 1)[0];
  chunk.data = new Uint8Array(data.buffer, 48);
  return chunk;
}

// notify sender I have received and saved the file successfully
function makeReceivedNotice(fileID){ // this is technically the same as makeRemoveReq, only with different dataType, consider factoring into one function
  var buf = new ArrayBuffer(32);
  new Float64Array(buf, 0, 1)[0] = 4; // dataType = 4

// there is a 8 bytes hole(padding purpose) between dataType and fileID
  var fileIDbuf = new Uint16Array(buf,16, 8);
  for(let i=0; i<fileIDbuf.length; i++){
    fileIDbuf[i] = fileID.charCodeAt(i)
  }
  return buf;
}

function parseReceivedNotice(data){ // this is technically the same as parseRemoveReq(), consider factoring into one function
  return String.fromCharCode.apply(null, new Uint16Array(data.buffer, 16, 8));
}

Filer.prototype._sendChunk = function({fileID, chunkIdx, peerID}){
  var p = this.peers[peerID].peerObj;
  var fileStat = this._getFileStat(fileID);
  if (!fileStat){ // file receiver still has fileID, but file sender doesn't, that means file sender has actively removed the file
    return
  }

  if (chunkIdx === 0){
    this._updateStatus({fileID: fileID, status: 'sending'})
  }

  const fileObj = this.peers[peerID].files.sending[fileID];
  var slice = fileObj.slice(chunkSize * chunkIdx , chunkSize * (1 + chunkIdx)); // slice(startingByte, excludingEndingByte)
  var reader = new window.FileReader();
  reader.readAsArrayBuffer(slice);
  reader.onload = function(evt) {
    var bufferSizeBuf = new Float64Array(1);
    bufferSizeBuf[0] = evt.target.result.byteLength;
    var fileChunkMeta = new ArrayBuffer(48);
    new Float64Array(fileChunkMeta, 0, 1)[0] = 3; // dataType
    new Float64Array(fileChunkMeta, 8, 1)[0] = chunkIdx;
    var fileIdBuf = new Uint16Array(fileChunkMeta, 32, 8); // fileID(8 character, 16 bytes)
    for(let i=0; i<fileIdBuf.length; i++){
      fileIdBuf[i] = fileID.charCodeAt(i)
    }

    var memStore = new Uint8Array(evt.target.result);
    const msgCount = Math.ceil( memStore.byteLength / msgPayloadSize );
    var msg, data;
    for (let i=0; i<msgCount; i++){
      new Float64Array(fileChunkMeta, 16, 1)[0] = i;
      data = memStore.slice(i * msgPayloadSize, (i+1) * msgPayloadSize);
      msg = new Uint8Array(48 + data.byteLength);
      msg.set(new Uint8Array(fileChunkMeta));
      msg.set(data, 48);
      p.send(msg);
    }
  };
};

Filer.prototype._getFileStat = function(fileID){
  var fileStat;
  for (let i = 0; i< this.tasks.length; i++){
    if (this.tasks[i].fileID === fileID){
      fileStat = this.tasks[i];
      break;
    }
  }
  return fileStat
};

Filer.prototype._updateProgress = function({fileID, progress, fileName, fileURL}){
  for (let i = 0; i < this.tasks.length; i++){
    if (this.tasks[i].fileID === fileID){
      this.emit('newProgress', {fileID, progress, fileName, fileURL}); // only file receivers pass fileName/fileURL when the whole file is saved
      this.tasks[i].progress = progress;
      if (progress === 1){
        this._updateStatus({fileID: fileID, status: 'done'})
      }
      break;
    }
  }
};

Filer.prototype._updateStatus = function({fileID, status}){
  for (let i = 0; i < this.tasks.length; i++){
    if (this.tasks[i].fileID === fileID){
      this.emit('newStatus', {fileID: fileID, status: status});
      this.tasks[i].status = status;
      break;
    }
  }
};

Filer.prototype._saveChunk = function(data) { // actually, it should be named _saveChunkMessage()
  var chunk = parseFileChunk(data.data);
  var fileStat = this._getFileStat(chunk.fileID);
  var p = this.peers[data.peerID].peerObj;

  if (!fileStat){ // file sender has fileID, but file receiver doesn't, that means file receiver has actively removed the file
    return
  }

  var receivingBuffer = this.peers[data.peerID].files.receiving[chunk.fileID];
  receivingBuffer.set(new Uint8Array(chunk.data), msgPayloadSize * chunk.msgIdx);

  if (chunk.chunkIdx === 0 && chunk.msgIdx === 0){
    this._updateStatus({fileID: chunk.fileID, status: 'receiving'})
  }

  const maxMsgCount = chunkSize / msgPayloadSize;
  if (chunk.msgIdx + 1 == maxMsgCount
      || chunk.msgIdx + chunk.chunkIdx * maxMsgCount == Math.floor(fileStat.fileSize / msgPayloadSize) ){

    var isLastChunk = chunk.chunkIdx + 1 == Math.ceil(fileStat.fileSize / chunkSize );
    if (isLastChunk){ // each chunkSize is "msgPayloadSize * 32", but the last chunk is probably less than that, I need to grab the exact size
      writeFile(p, receivingBuffer.slice(0, chunk.msgIdx * msgPayloadSize + chunk.data.length), chunk.chunkIdx, fileStat, isLastChunk, this._updateProgress.bind(this));
    } else {
      writeFile(p, receivingBuffer, chunk.chunkIdx, fileStat, isLastChunk, this._updateProgress.bind(this));
    }
  }
};

Filer.prototype._parseData = function(data){
  var fileID, dataType = new Float64Array(data.data.buffer, 0, 1)[0]; // it's the data.buffer need to be parsed, not data
  switch (dataType){
    case 0: // fileMeta: filename, size, id, type
      var fileInfo = parseFileMeta(data.data); // todo: case 0 也像其他case一样,放在函数中单独处理.
      if (!this.peers[data.peerID].files.receiving[ fileInfo.id ]){
        this.peers[data.peerID].files.receiving[ fileInfo.id ] = new Uint8Array( chunkSize ); // create buffer for incoming file chunk data
      }
      var newTask = {
        fileID: fileInfo.id, fileName: fileInfo.name.substr(0, fileInfo.nameLength),
        fileSize: fileInfo.size, fileType: fileInfo.type.substr(0, fileInfo.typeLength),
        progress: 0, from: data.peerID, to: this.myID, status: 'pending'
      };
      this.tasks.push(newTask);
      this.emit('newTask', newTask);
      this.peers[data.peerID].peerObj.send( makeFileChunkReq({chunkIdx: 0, id: fileInfo.id}) ); // send the chunk req for the 1st chunk
      break;

    case 1: // fileChunkReq, receiver send the chunk requested(read from disk into memStore first)
      var chunkInfo = parseFileChunkReq(data.data);
      var fileStat = this._getFileStat(chunkInfo.id); // todo: case 3 是不fileStat是否存在, 放在 saveChunk中判断, 而本例case1最好也放在 sendChunk中判断, 否则显得太罗嗦. updateProgress 也放在 sendChunk中
      if (!fileStat) return; // undefined fileStat means user has removed this file(and cancel the whole file transfer operation)

      if (chunkInfo.chunkIdx > 0){ // when the next fileChunkReq comes, I know the previous chunk has been sent
        this._updateProgress({fileID: chunkInfo.id, progress: chunkSize * chunkInfo.chunkIdx / fileStat.fileSize});
      }
      this._sendChunk({fileID: chunkInfo.id, chunkIdx: chunkInfo.chunkIdx, peerID: data.peerID});
      break;

    case 2: // file remove request, whenever sender/receiver received this req, stop sending/receiving the next chunk, and remove all accompanying data
      fileID = parseRemoveReq(data.data);
      console.log('fileRemoveReq received: ', fileID);
      this.removeTask(fileID);
      break;

    case 3: // fileChunk data, receiver save it into file buffer, actually it's one piece of the fileChunk
      this._saveChunk(data);
      break;

    case 4: // file receiver notify file sender, the file has been successfully saved into FileSystem
      this._updateProgress({
        fileID: parseReceivedNotice(data.data),
        progress: 1
      });
      this._runTask(); // p2p connection might take few seconds to create, during that time, users might send multiple files to the same peer
      break; // when p2p connection established, only the first pending task get to run, we need to run the rest if there are.

    default:
      console.log('Oops, unknown data type: ', dataType)
  }
};

const writeFile = (peer, data, chunkIdx, fileObj, isLastChunk, updateProgress) => {
  if (fileObj.fileWriter) { // todo, when the whole file is done writing, remove this fileWriter on fileObj(in tasks)
    doWriting(fileObj.fileWriter, fileObj, peer, chunkIdx, data, isLastChunk, updateProgress);
  } else {
    fs(fileObj).then(fileExists).then(getFile).then(getFileWriter).then(writer => {
      doWriting(writer, fileObj, peer, chunkIdx, data, isLastChunk, updateProgress);
    }, err => { // any error or reject in the upstream promise chain would be handled in this block.
      console.log('error in promise chain: ', err);
      fileObj.fileWriter = null;
    });
  }
};

const doWriting = (writer, fileObj, peer, chunkIdx, data, isLastChunk, updateProgress) => {
  writer.seek( chunkIdx * chunkSize);
  writer.onerror = e => {console.log('Write failed: ' + e.toString()); }; // todo: need an universal err handler(send err msg to peer)
  writer.write(new Blob([data], {type: fileObj.fileType}));
  writer.onwriteend = e => {
    if (isLastChunk){
      var url = 'filesystem:' + window.location.protocol + '//' + window.location.hostname;
      var port = window.location.port ? ':' + window.location.port : '';
      url += port + '/temporary/' + fileObj.fileName;
      url = encodeURI(url);
      updateProgress({fileID: fileObj.fileID, progress: 1, fileName: fileObj.fileName, fileURL: url});
      peer.send(makeReceivedNotice(fileObj.fileID));
    } else {
      updateProgress({fileID: fileObj.fileID, progress: (chunkIdx + 1) * chunkSize / fileObj.fileSize});
      peer.send(makeFileChunkReq({chunkIdx: chunkIdx + 1, id: fileObj.fileID}));
    }
  }; // even if error occurred during write(), onwriteend still got fired, causing the wrong seek value
};

// ------------------------- filesystem API
window.requestFileSystem = window.requestFileSystem || window.webkitRequestFileSystem;

const fs = fileObj => {
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

const removeFile =  ({fileEntry}) => { // fs(fileObj).then(getFile).then(removeFile), fileObj must at least has a fileName property
  return new Promise(function(resolve, reject){
    fileEntry.remove(()=>{
      resolve('success')
    }, err => reject(err))
  })
};

// EventEmitter, credit: https://gist.github.com/mudge/5830382
function EventEmitter(){
  this.events = {};
}

EventEmitter.prototype.on = function (event, listener) {
  if (typeof this.events[event] !== 'object') {
    this.events[event] = [];
  }

  this.events[event].push(listener);
};

EventEmitter.prototype.removeListener = function (event, listener) {
  var idx;
  if (typeof this.events[event] === 'object') {
    idx = this.events[event].indexOf(listener);
    if (idx > -1) {
      this.events[event].splice(idx, 1);
    }
  }
};

EventEmitter.prototype.emit = function (event) {
  var i, listeners, length, args = [].slice.call(arguments, 1);

  if (typeof this.events[event] === 'object') {
    listeners = this.events[event].slice();
    length = listeners.length;

    for (i = 0; i < length; i++) {
      listeners[i].apply(this, args);
    }
  }
};

EventEmitter.prototype.once = function (event, listener) {
  this.on(event, function g () {
    this.removeListener(event, g);
    listener.apply(this, arguments);
  });
};

// credit: https://stackoverflow.com/questions/10726909/random-alpha-numeric-string-in-javascript
function randomString(length, chars) {
  length = length || 8;
  chars = chars || '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var result = '';
  for (var i = length; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}
