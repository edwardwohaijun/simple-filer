const Peer = require('simple-peer');
const msgPayloadSize = 64 * 1024 - 48; // msgSize of data channel: 64k, then subtract: dataType(8 bytes), chunkIdx(8 bytes), msgIdx(8 bytes), padding(8 bytes), fileID(16bytes(8 characters))
const chunkSize = msgPayloadSize * 32; // each chunk need to send 32 msg(at most) in a loop. This is also the size of local read/write buffer to store the current chunk

module.exports = Filer;
function Filer({myID, signalingChannel, webrtcConfig, timeout}){
  this.myID = myID || '';
  this.signalingChannel = signalingChannel || null;
  this._webrtcConfig = webrtcConfig; // could be null
  this._timeout = timeout || 12; // if peer is still not connected 20s after calling createPeerConnection, consider it as failure, emit error notifying user to take further action

  window.requestFileSystem = window.requestFileSystem || window.webkitRequestFileSystem;
  this.isFileSystemAPIsupported = !!window.requestFileSystem;
}

Filer.prototype = new EventEmitter();
//Filer.prototype = Object.create(EventEmitter.prototype); // this is not gonna work, because the EM's this.events obj is not initialised, you must use an instance of EM.
Filer.prototype.constructor = Filer;
Filer.prototype.peers = {}; // should be renamed to _peers
Filer.prototype.tasks = []; // ditto

Filer.prototype.FileSystemQuota = function(){
  /*
  // FileSystemQuota might get passed as success callback in .then() in promise chain, "this" will be interpreted as "undefined" or "window" in this context.
  // thus, can't use the following:
  if (!this.isFileSystemAPIsupported) {
    return Promise.reject("your browser doesn't support FileSystem API, please use Chrome")
  }
  // https://stackoverflow.com/questions/41726181/promise-then-execution-context-when-using-class-methods-as-callback
  */
  if (!window.requestFileSystem) {
        return Promise.reject("your browser doesn't support FileSystem API, please use Chrome")
  }

  return new Promise(function(resolve, reject){
    navigator.webkitTemporaryStorage.queryUsageAndQuota (
        function(usedBytes, grantedBytes){
          resolve({
            usedBytes: usedBytes,
            grantedBytes: grantedBytes
          })
        },
        function(err){
          reject("error querying temporary storage quota: " + err)
        }
    );
  });
};

Filer.prototype.removeAllFiles = function(){ // it's easier to implement this function, if all files are saved in a pre-defined directory, then recursively remove it
  return new Promise(function(resolve, reject){
    fs(null) // fs function needs a fileObj, returns a promise, resolving to {rootFS, fileObj}, I just need the rootFS, thus passing a null
      .then(function({root:root}){
        let entries = [];
        let dirReader = root.createReader();
          dirReader.readEntries(function(results) { // Call readEntries() until no more results are returned.
            for (var i = 0; i < results.length; i++){
              let p = (function(i){ // "immediately-invoked-function" here is to prevent all iteration have the same "i" value
                return new Promise(function(resolve, reject){
                  results[i].remove(function(){ // todo: if isDir, remove it recursively
                    resolve("entry removed");
                  }, function(err){
                    console.log("err removing entry: ", err, ", but continue the next removal");
                    resolve("entry not removed") // failure to remove one file should NOT break the whole promise chain
                  })
                })
              })(i);
              entries.push(p);
            }
            Promise.all(entries)
                .then(function(){resolve("all removed")})
                .catch(function(err){reject("failed to remove all files")})
          });
      })
      .catch(function(err){
        reject("err removing all files: ", err)
      });
  });
};

Filer.prototype._createPeerConnection = function (offerUID, answerUID, isInitiator, signalingChannel) { // todo: use object as the only argument, rather than list of arguments
  var peerID = isInitiator ? answerUID : offerUID;
  if (this.peers[peerID]){ // this.peers[peerID] is an obj with 2 properties: peerObj and files
    this.peers[peerID].peerObj = new Peer({initiator: isInitiator, trickle: true, config: this._webrtcConfig});
  } else {
    this.peers[peerID] = {peerObj: new Peer({initiator: isInitiator, trickle: true, config: this._webrtcConfig})}
  }

  if (!this.peers[peerID].files){ // peerObj is created by _createPeerConnection(), files obj is created by _send() function
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
    this.emit('connect', p._peerID);
    this._runTask()
  }.bind(this));

  p.on('data', function(data){
    this._parseData({data: data, peerID: p._peerID});
  }.bind(this));

  p.on('close', function(){ // todo: close and error evt handler need to destroy all localBuffer, partly saved chunk and all other bookkeeping data...
    this.emit('error/peer', new FilerError({name: 'PeerError', code: "ERR_PEER_CLOSED", message: "connection with peerID: " + p._peerID + " closed", peerID: p._peerID}))
  // ..., call removeTask() repeatedly to remove all associated data
  }.bind(this));

  p.on('error', function(err){
    this.emit('error/peer', new FilerError({name: 'PeerError', code:"ERR_PEER_ERROR", message: 'peer(' + p._peerID + ') error: ' + err.message, peerID: p._peerID}));
  }.bind(this));

  if (p.initiator){
    setTimeout(function(){
      if (!p.connected){
        this.emit('error/peer', new FilerError({name: 'PeerConnectionFailed', code:"ERR_PEER_CONNECTION_FAILED", message: 'failed to create P2P connection with ' + p._peerID, peerID: p._peerID}));
        p.destroy()
      }
    }.bind(this), this._timeout * 1000);
  }

  return p
};

// createConnection is a wrapper of _createPeerConnection function. Sometimes, you want to create peer connection before attempting to send a file.
// This function returns a peer object, but you don't need it. You just listen on "connect" and "error/peer" events to check whether P2P connection has established.
Filer.prototype.createConnection = function(peerID){
  return this._createPeerConnection(this.myID, peerID, true, this.signalingChannel);
};

Filer.prototype.handleSignaling = function(data){
  var p;
  this.peers[data.from] && (p = this.peers[data.from].peerObj);

 // todo: potential conflicting condition: A and B try to establish connection to other side at the same time
 // there must be only one offerer, one answerer
  if (!p){ // I'm answerer(initiator == false)
    p = this._createPeerConnection(data.from, this.myID, false, this.signalingChannel);
  }
  p.signal(data.signalingData);
};

Filer.prototype.send = function(toWhom, fileObj){
  if (!(fileObj instanceof File)) {
    this.emit('error/file', new FilerError({name: 'InvalidFileObject', code:"ERR_INVALID_FILE", message: 'invalid file object to send to peer: ' + toWhom, peerID: toWhom}));
    return
  }
  if (toWhom == null || toWhom === "") {
    this.emit('error/file', new FilerError({name: 'InvalidPeerID', code:"ERR_INVALID_PEERID", message: 'invalid peer id', peerID: null}));
    return
  }
  var fileID = randomString();
  var newTask = {
    fileID: fileID, fileName: fileObj.name, fileSize: fileObj.size, fileType: fileObj.type,
    progress: 0, from: this.myID, to: toWhom, status: 'pending' // status: pending/sending/receiving/done/removed
  };
  this.tasks.push(newTask);
  this.emit('task', newTask);

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
    //console.log('p exist, but not ready, just wait');
  } else {
    //console.log('p does not exist, create it now');
    this._createPeerConnection(this.myID, toWhom, true, this.signalingChannel);
  }
};

Filer.prototype.removeTask = function(fileID){
// removeTask() is called either by user clicking the 'remove' button, or receiving the 'removeReq' peer msg
// 2 pieces of data need to be removed for file sender: item in tasks array, object on this.peers.peerID.files.sending.fileID
// 3 pieces of data need to be removed for file receiver: ...................array buffer on ..................receiving.fileID, and written chunk in chrome FileSystem

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
  if (taskIdx !== -1){ // redundant ???
    this.tasks.splice(taskIdx, 1);
  }
};

Filer.prototype._runTask = function(){
  var t;
  for(let i = 0; i < this.tasks.length; i++) {
    if (this.tasks[i].status === 'pending') { // _runTask only run when p2p connection is established, thus when status is always pending, it means p2p connection failed
      this.tasks[i].status = '_running'; // the 'pending' status is soon to be updated by _sendChunk(and _saveChunk), but before that happened, there is a chance ...
      t = this.tasks[i]; // ... user click 'send' again, that causes the same 'pending' task to run again. Thus, setting to '_running' prevent that case....
      break; // ..., another approach is to use this.tasks.unshift(newTask) instead of this.tasks.push()
    }
  }
  if (t) {
    if (t.from === this.myID) { // I'm the file sender
      var fileInfo = {id: t.fileID, size: t.fileSize, name: t.fileName, type: t.fileType, to: t.to};
      this.peers[fileInfo.to].peerObj.send( makeFileMeta(fileInfo) )
    } else if (t.to === this.myID){ // I'm the file receiver
      //console.log('receiving file now, wait for fileMeta');
    } else {
      console.log('Oops, not supposed to happen')
    }
  }
};

/*
---------- data protocol -----------------
first 8 bytes is data type, just an integer from 0 to 4, 1 byte is enough, but for the padding purpose
0(fileMeta), file sender send this msg to file receiver, ask it to save this info(fileID/Name/Size/Type/...) in tasks obj, create the buffer to hold the incoming chunk, then send back the fileChunkReq
1(fileChunkReq), msg receiver(file sender) parse this msg, extract the fileID/chunkIdx, then read the data from file object, send the chunk(in a for loop) to file receiver
2(removeReq), msg receiver parse this msg, extract the fileID, do some cleanup for the specified file
3(fileChunk), file receiver parse this msg, save the msg data in corresponding buffer, if this is the last msg in a chunk, save the whole chunk in chrome FileSystem
4(receivedNotice), file receiver send this msg to file sender, notifying that the file has been successfully saved in chrome fileSystem
fileID consumes 16bytes(8 random characters), fileIdx consumes 8bytes(just an integer),
*/

// ------------------- data maker and parser
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
    if (i === fileInfo.name.length) break;
    fileName[i] = fileInfo.name.charCodeAt(i)
  }

  new Float64Array(buf, 176, 1)[0] = fileInfo.type.length;

  var fileType = new Uint16Array(buf, 192);
  for(let i = 0; i<fileType.length; i++){
    if (i === fileInfo.type.length) break;
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

// ------------------- data processing methods
Filer.prototype._processFileMeta = function(data){
  var fileInfo = parseFileMeta(data.data);
  if (!this.peers[data.peerID].files.receiving[ fileInfo.id ]){
    this.peers[data.peerID].files.receiving[ fileInfo.id ] = new Uint8Array( chunkSize ); // create local write buffer for incoming chunk data
  }
  var newTask = {
    fileID: fileInfo.id, fileName: fileInfo.name.substr(0, fileInfo.nameLength),
    fileSize: fileInfo.size, fileType: fileInfo.type.substr(0, fileInfo.typeLength),
    progress: 0, from: data.peerID, to: this.myID, status: 'pending'
  };
  this.tasks.push(newTask);
  this.emit('task', newTask);
  this.peers[data.peerID].peerObj.send( makeFileChunkReq({chunkIdx: 0, id: fileInfo.id}) ); // send the chunk req for the 1st chunk
};

Filer.prototype._sendChunk = function(data){
  var chunkInfo = parseFileChunkReq(data.data);
  var fileStat = this._getFileStat(chunkInfo.id);
  if (!fileStat) return; // file receiver still has fileID, but file sender doesn't, that means file sender has actively removed the file

  if (chunkInfo.chunkIdx === 0){
    this._updateStatus({fileID: chunkInfo.id, status: 'sending'})
  } else { // when the next fileChunkReq comes, I know the previous chunk has been saved
    this._updateProgress({fileID: chunkInfo.id, progress: chunkSize * chunkInfo.chunkIdx / fileStat.fileSize});
  }

  var p = this.peers[data.peerID].peerObj;
  const fileObj = this.peers[data.peerID].files.sending[chunkInfo.id];
  var slice = fileObj.slice(chunkSize * chunkInfo.chunkIdx , chunkSize * (1 + chunkInfo.chunkIdx)); // slice(startingByte, excludingEndingByte)
  var reader = new window.FileReader();
  reader.readAsArrayBuffer(slice);
  reader.onload = function(evt) {
    var fileChunkMeta = new ArrayBuffer(48);
    new Float64Array(fileChunkMeta, 0, 1)[0] = 3; // dataType
    new Float64Array(fileChunkMeta, 8, 1)[0] = chunkInfo.chunkIdx;
    var fileIdBuf = new Uint16Array(fileChunkMeta, 32, 8); // fileID(8 character, 16 bytes)
    for(let i=0; i<fileIdBuf.length; i++){
      fileIdBuf[i] = chunkInfo.id.charCodeAt(i)
    }

    var localBuffer = new Uint8Array(evt.target.result);
    const msgCount = Math.ceil( localBuffer.byteLength / msgPayloadSize );
    var msg, data;
    for (let i=0; i<msgCount; i++){
      new Float64Array(fileChunkMeta, 16, 1)[0] = i;
      data = localBuffer.slice(i * msgPayloadSize, (i+1) * msgPayloadSize);
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
      this.emit('progress', {fileID, progress, fileName, fileURL}); // only file receivers pass fileName/fileURL when the whole file is saved
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
      this.emit('status', {fileID: fileID, status: status});
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
  if (chunk.msgIdx + 1 === maxMsgCount
      || chunk.msgIdx + chunk.chunkIdx * maxMsgCount === Math.floor(fileStat.fileSize / msgPayloadSize) ){

    var isLastChunk = chunk.chunkIdx + 1 === Math.ceil(fileStat.fileSize / chunkSize );
    if (isLastChunk){ // each chunkSize is "msgPayloadSize * 32", but the last chunk is probably less than that, I need to grab the exact size
      writeFile(p, receivingBuffer.slice(0, chunk.msgIdx * msgPayloadSize + chunk.data.length), chunk.chunkIdx, fileStat, isLastChunk, this._updateProgress.bind(this), this.emit.bind(this));
    } else {
      writeFile(p, receivingBuffer, chunk.chunkIdx, fileStat, isLastChunk, this._updateProgress.bind(this), this.emit.bind(this));
    }
  }
};

Filer.prototype._parseData = function(data){
  var fileID, dataType = new Float64Array(data.data.buffer, 0, 1)[0]; // it's the data.buffer need to be parsed, not data
  switch (dataType){
    case 0: // fileMeta(filename, size, id, type), msg receiver(also the file receiver) need this info to prepare for the incoming chunk
      this._processFileMeta(data);
      break;

    case 1: // fileChunkReq, msg receiver send the chunk requested(read from disk into localBuffer first)
      this._sendChunk(data);
      break;

    case 2: // file remove request, whenever sender/receiver received this req, stop sending/receiving the next chunk, and remove all accompanying data
      fileID = parseRemoveReq(data.data);
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

    case 5: // not implemented yet
      console.log('error from peers');
      break;

    default:
      this.emit('error/file', new FilerError({
        name: 'UnknownMessageType', code:"ERR_UNKNOWN_MESSAGE_TYPE", message: 'unknown message type: ' + dataType + ' received from peer: ' + data.peerID,
        peerID: data.peerID, fileID: fileID
      }));
      console.log('Oops, unknown data type: ', dataType)
  }
};

// ------------------- Chrome Filesystem writing utilities
const writeFile = function(peer, data, chunkIdx, fileObj, isLastChunk, updateProgress, emit){
  if (fileObj.fileWriter) { // todo, when the whole file is done writing, remove this fileWriter on fileObj(in tasks)
    doWriting(fileObj.fileWriter, fileObj, peer, chunkIdx, data, isLastChunk, updateProgress, emit);
  } else {
    fs(fileObj).then(fileExists).then(getFile).then(getFileWriter).then(function(writer) {
      doWriting(writer, fileObj, peer, chunkIdx, data, isLastChunk, updateProgress, emit);
    }, function(err) {
      emit('error/file', new FilerError({
        name: 'ChromeFileSystemError', code: "ERR_CHROME_FILESYSTEM_ERROR",  message: err.message || 'failed to get FileSystem Writer',
        peerID: peer._peerID, fileID: fileObj.fileID
      }));
      fileObj.fileWriter = null;
    });
  }
};

const doWriting = function(writer, fileObj, peer, chunkIdx, data, isLastChunk, updateProgress, emit) {
  writer.seek( chunkIdx * chunkSize);
  writer.onerror = function(err) {
    //console.log('Write failed: ' + err.toString());
    emit('error/file', new FilerError({
      name: 'ChromeFileSystemError', code: "ERR_CHROME_FILESYSTEM_ERROR", message: err.message || 'failed to write into ChromeFileSystem',
      peerID: peer._peerID, fileID: fileObj.fileID
    }));
    // todo: sending side need to be notified of this error, otherwise, senders don't know what's going on, why transfer stopped
  };
  writer.write(new Blob([data], {type: fileObj.fileType}));
  writer.onwriteend = function(e) {
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

// ------------------------- Chrome filesystem API(Promise wrapper)
const fs = function(fileObj) {
  return new Promise(function (resolve, reject) {
    window.requestFileSystem(window.TEMPORARY, 4*1024*1024*1024,
        function({root}){
          resolve({root:root, fileObj: fileObj})
        },
        function(err) {
          reject(err)
        }
    );
  });
};

const fileExists = function({root, fileObj}){
  return new Promise(function(resolve, reject) {
    root.getFile(fileObj.fileName, {create: false}, // the point is not to get the fileEntry, but check whether the file with fileName already exists, thus use "create: false"
            function(fileEntry) {
              var filename = fileObj.fileName.substring(0, fileObj.fileName.lastIndexOf('.'));
              var ext = fileObj.fileName.substring(fileObj.fileName.lastIndexOf('.'));
              var randomStr = randomString(); // if the file with fileName already exists, append the new filename with _randomStr ...
              fileObj.fileName = filename + '_' + randomStr + ext; // ... and file extension
              resolve({root:root, fileObj: fileObj});
            },
            function(err) { // NOT_FOUND_ERR(or NotFoundError) occurred when the file with fileName doesn't exist...
              // ..., but in my case, this is not an error, so I call resolve(), only other type of errors need to call reject(err)
              //console.log(err.name);
              if (err.name === 'NOT_FOUND_ERR' || err.name === 'NotFoundError'){ // chrome 54's err.name is NotFoundError, prior version use: NOT_FOUND_ERR
                resolve({root:root, fileObj: fileObj});
              } else {
                reject(err)
              }
            }
    );
  })
};

const getFile = function({root, fileObj}) { // create the file and return its fileEntry obj
  return new Promise(function(resolve, reject){
    root.getFile(fileObj.fileName, {create:true},
        function(fileEntry) {
          resolve({fileEntry: fileEntry, fileObj: fileObj});
        },
        function(err) {
          reject(err)
        })
  })
};

const getFileWriter = function({fileEntry, fileObj}) {
  return new Promise(function(resolve, reject){
    fileEntry.createWriter(
        function(fileWriter) {
          fileObj.fileWriter = fileWriter;
          resolve(fileWriter)
        },
        function(err){
          reject(err)
        })
  })
};

const removeFile = function({fileEntry}) { // fs(fileObj).then(getFile).then(removeFile), fileObj must have a fileName property
  return new Promise(function(resolve, reject){
    fileEntry.remove(
        function() {
          resolve()
        },
        function(err){
          reject(err)
        })
  })
};

// ------------------- EventEmitter, credit: https://gist.github.com/mudge/5830382
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

// ------------------ Custom Error object
function FilerError({name, code, message, peerID, fileID}){
  // name should be the constructor function name(FilerError in this case), but I don't want to create one constructor for one error.
  this.name = name || 'UnknownError';
  this.code = code || 'ERR_UNKNOWN_ERROR';
  this.message = message || 'unknown error';
  this.peerID = peerID;
  this.fileID = fileID;
}
FilerError.prototype = Object.create(Error.prototype);
FilerError.constructor = FilerError;

// ------------------ other utilities
// credit: https://stackoverflow.com/questions/10726909/random-alpha-numeric-string-in-javascript
function randomString(length, chars) {
  length = length || 8;
  chars = chars || '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var result = '';
  for (var i = length; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}
