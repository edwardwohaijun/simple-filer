module.exports = Filer;

var Peer = require('simple-peer');
function Filer({myID, ws}){
  this.signalingChannel = ws || null;
  this.myID = myID || '';
}
Filer.prototype.peers = {};
Filer.prototype.tasks = [];

Filer.prototype._createPeerConnection = function (offerUID, answerUID, initiator, signalingChannel) { // todo 用obj作为参数，而非多个individual arguments
  var peerID = initiator ? answerUID : offerUID;
  this.peers[ peerID ] = {
    peerObj: new Peer({initiator: initiator, trickle: true}),
    files: {} // key is fileID, value is obj containing file's binary data, other meta info
  };
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

  fileObj.id = randomString();
  this.tasks.push({file: fileObj, from: this.myID, to: toWhom, status: 'pending'}); // status: running/pending/done
  //var p = this.peers[toWhom];
  var p;
  this.peers[toWhom] && (p = this.peers[toWhom].peerObj);
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
      var fileInfo = {id: t.file.id, size: t.file.size, name: t.file.name, to: t.to};
      this.peers[fileInfo.to].peerObj.send( makeFileMeta(fileInfo) )
    } else if (t.to == this.myID){ // I'm the file receiver
      //this.peers[t.from].send("the file I want is: " + t.file.name + ' fileID: ' + t.file.id);
      //this._receiveFile()
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
  // |dataType = 0(8bytes)|fileSize(8bytes)|fileID(8 chars, 16bytes)|fileName(at most 64 chars(128bytes))|
  var buf = new ArrayBuffer( 8 + 8 + 16 + 128 );
  new Float64Array(buf, 0, 1)[0] = 0; // dataType(8 bytes) = 0
  new Float64Array(buf, 8, 1)[0] = fileInfo.size; // fileSize(8 bytes)

  var fileID = new Uint16Array(buf,16, 8); // fileID(8 character, 16 bytes)
  for(let i=0; i<fileID.length; i++){
    fileID[i] = fileInfo.id.charCodeAt(i)
  }

  var fileName = new Uint16Array(buf, 32); // fileName
  for(let i=0; i<fileName.length; i++){
    if (i == fileInfo.name.length) break;
    fileName[i] = fileInfo.name.charCodeAt(i)
  }
  return buf;
}

function parseFileMeta(data){
  var fileInfo = {};
  fileInfo.size = new Float64Array(data.buffer, 8, 1)[0];
  fileInfo.id = String.fromCharCode.apply(null, new Uint16Array(data.buffer, 16, 8));
  fileInfo.name = String.fromCharCode.apply(null, new Uint16Array(data.buffer, 32));
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

function makeFileChunk(){ // |dataType|
  //
}

function parseFileChunk(){

}

Filer.prototype._parseData = function(data){
  var dataType = new Float64Array(data.data.buffer, 0, 1)[0]; // 凡是data channel过来的数据, 需要parse, 一律读取该数据的 data.buffer
  switch (dataType){
    case 0: // fileMeta, receive get ready to receive(create memStore)
      var fileInfo = parseFileMeta(data.data);
      console.log('FileMeta, create memStore and get ready to receive'); // we have filename/size, show them on page, and create memStore
      this.peers[data.peerID].peerObj.send( makeFileChunkReq({chunkIdx: 0, id: fileInfo.id}) ); // send the chunk req for the 1st chunk
      break;
    case 1: // fileChunkReq, receiver send the chunk requested(read from file obj)
      var chunkInfo = parseFileChunkReq(data.data);
      console.log('File chunk request, chunkinfo: ', chunkInfo);
      break;
    case 2: // fileChunk, receiver save it into memStore, actually it's one piece of the fileChunk
      console.log('the file chunk msg I want, save it now');
      break;
    default:
      console.log('Oops, unknown data type')
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


